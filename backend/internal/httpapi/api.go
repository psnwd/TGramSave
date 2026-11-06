package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"

	"tgramsave/backend/internal/config"
	"tgramsave/backend/internal/store"
)

type stats struct {
	registers    atomic.Int64
	claims       atomic.Int64
	webhooks     atomic.Int64
	unauthorized atomic.Int64
	rateLimited  atomic.Int64
}

func (s *stats) snapshot() gin.H {
	return gin.H{
		"registers":    s.registers.Load(),
		"claims":       s.claims.Load(),
		"webhooks":     s.webhooks.Load(),
		"unauthorized": s.unauthorized.Load(),
		"rateLimited":  s.rateLimited.Load(),
	}
}

type API struct {
	cfg    config.Config
	store  *store.Store
	reg    *limiter // /v1/register
	claim  *limiter // /v1/claim
	hook   *limiter // /webhooks/kofi, per IP: stops token guessing
	badAdm *limiter // failed /admin attempts, per IP
	stats  *stats
}

func New(cfg config.Config, s *store.Store) http.Handler {
	a := &API{
		cfg:    cfg,
		store:  s,
		reg:    newLimiter(10, time.Hour),
		claim:  newLimiter(10, time.Hour),
		hook:   newLimiter(120, time.Hour),
		badAdm: newLimiter(10, 15*time.Minute),
		stats:  &stats{},
	}
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), securityHeaders, requestLog())
	// Only trust the client-IP header the platform sets (Fly-Client-IP etc.); otherwise RemoteAddr. Never raw X-Forwarded-For.
	r.SetTrustedProxies(nil)
	r.TrustedPlatform = cfg.ClientIPHeader
	r.HandleMethodNotAllowed = true

	r.GET("/healthz", func(c *gin.Context) { c.String(200, "ok") })
	r.GET("/readyz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if err := s.Ping(ctx); err != nil {
			c.String(http.StatusServiceUnavailable, "not ready")
			return
		}
		c.String(200, "ready")
	})
	r.GET("/v1/plans", a.plans)
	r.POST("/v1/register", a.register)
	r.GET("/v1/status", a.auth(a.status))
	r.POST("/v1/claim", a.auth(a.claimEmail))
	r.POST("/webhooks/kofi", a.kofi)
	if cfg.AdminToken != "" {
		adm := r.Group("/admin", a.admin)
		adm.GET("/plans", a.adminList)
		adm.PUT("/plans/:key", a.adminPut)
		adm.DELETE("/plans/:key", a.adminDelete)
		adm.GET("/metrics", func(c *gin.Context) { c.JSON(200, a.stats.snapshot()) })
	}
	return r
}

// requestLog is deliberately minimal: method, path, status and latency. Never logs query strings or
// bodies (Ko-fi payloads contain emails).
func requestLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Printf("%s %s -> %d (%s)", c.Request.Method, c.Request.URL.Path, c.Writer.Status(),
			time.Since(start).Round(time.Millisecond))
	}
}

// --- helpers ---

func securityHeaders(c *gin.Context) {
	h := c.Writer.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
	c.Next()
}

func fail(c *gin.Context, err error) {
	log.Printf("error: %v", err)
	c.String(http.StatusInternalServerError, "internal error")
}

func deny(c *gin.Context, code int, msg string) { c.String(code, msg); c.Abort() }

// bearer returns the token only when the header is exactly "Bearer <token>".
func bearer(c *gin.Context) string {
	t, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return strings.TrimSpace(t)
}

func (a *API) limit(c *gin.Context, l *limiter) bool {
	if l.allow(c.ClientIP()) {
		return true
	}
	a.stats.rateLimited.Add(1)
	deny(c, http.StatusTooManyRequests, "too many requests")
	return false
}

// limiter: fixed window per key. ponytail: in-memory, single instance; use a shared store if scaled out.
type limiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(n int, w time.Duration) *limiter {
	return &limiter{n: n, window: w, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) > 10000 { // evict only expired keys; wiping all would let a key flood reset everyone's limit
		for k, ts := range l.hits {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= l.window {
				delete(l.hits, k)
			}
		}
	}
	recent := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.n {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

func (l *limiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, t := range l.hits[key] {
		if time.Since(t) < l.window {
			n++
		}
	}
	return n >= l.n
}

// --- extension API ---

type statusResp struct {
	Tier      string `json:"tier"` // "free" | "premium"
	ExpiresAt *int64 `json:"expiresAt"`
	Lifetime  bool   `json:"lifetime"`
	Code      string `json:"code"`
}

func status(i *store.Install) statusResp {
	r := statusResp{Tier: "free", Code: i.Code}
	if i.PremiumUntil > time.Now().Unix() {
		r.Tier = "premium"
		if r.Lifetime = i.PremiumUntil == store.Lifetime; !r.Lifetime {
			r.ExpiresAt = &i.PremiumUntil
		}
	}
	return r
}

func (a *API) auth(h func(*gin.Context, *store.Install)) gin.HandlerFunc {
	return func(c *gin.Context) {
		tok := bearer(c)
		if tok == "" {
			a.stats.unauthorized.Add(1)
			deny(c, http.StatusUnauthorized, "unauthorized")
			return
		}
		i, err := a.store.InstallBySecret(tok)
		if err != nil {
			fail(c, err)
		} else if i == nil {
			a.stats.unauthorized.Add(1)
			deny(c, http.StatusUnauthorized, "unauthorized")
		} else {
			h(c, i)
		}
	}
}

func (a *API) plans(c *gin.Context) {
	ps, err := a.store.Plans(true)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(200, ps)
}

func (a *API) register(c *gin.Context) {
	if !a.limit(c, a.reg) {
		return
	}
	id, secret, code, err := a.store.CreateInstall()
	if err != nil {
		fail(c, err)
		return
	}
	a.stats.registers.Add(1)
	c.JSON(201, gin.H{"id": id, "secret": secret, "code": code})
}

func (a *API) status(c *gin.Context, i *store.Install) { c.JSON(200, status(i)) }

func (a *API) claimEmail(c *gin.Context, i *store.Install) {
	if !a.limit(c, a.claim) {
		return
	}
	var body struct {
		Email string `json:"email"`
		Txn   string `json:"txn"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
	if c.ShouldBindJSON(&body) != nil || !validEmail(body.Email) {
		c.String(http.StatusBadRequest, "valid email required")
		return
	}
	if body.Txn == "" && !a.cfg.AllowEmailClaim {
		c.String(http.StatusBadRequest, "ko-fi transaction id required")
		return
	}
	if err := a.store.Claim(i.ID, body.Email, body.Txn, a.cfg.AllowEmailClaim); err != nil {
		if errors.Is(err, store.ErrProofRequired) {
			c.String(http.StatusBadRequest, "ko-fi transaction id required")
			return
		}
		fail(c, err)
		return
	}
	i, err := a.store.InstallBySecret(bearer(c))
	if err != nil {
		fail(c, err)
		return
	}
	a.stats.claims.Add(1)
	c.JSON(200, status(i))
}

func validEmail(e string) bool {
	a, err := mail.ParseAddress(e)
	return err == nil && a.Address == e && len(e) <= 254
}

// --- Ko-fi webhook ---

var codeRe = regexp.MustCompile(`TGS-[A-Z0-9]{4}-[A-Z0-9]{4}`)

func (a *API) kofi(c *gin.Context) {
	if !a.limit(c, a.hook) {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	var d struct {
		VerificationToken string `json:"verification_token"`
		MessageID         string `json:"message_id"`
		TxnID             string `json:"kofi_transaction_id"`
		Email             string `json:"email"`
		Message           string `json:"message"`
		TierName          string `json:"tier_name"`
		Amount            string `json:"amount"`
		ShopItems         []struct {
			Code string `json:"direct_link_code"`
		} `json:"shop_items"`
	}
	err := c.Request.ParseForm()
	raw := c.Request.PostFormValue("data")
	if err == nil && json.Unmarshal([]byte(raw), &d) != nil {
		err = errors.New("bad json")
	}
	// Authenticate before doing anything with the payload.
	if err == nil && subtle.ConstantTimeCompare([]byte(d.VerificationToken), []byte(a.cfg.KofiToken)) != 1 {
		deny(c, http.StatusUnauthorized, "unauthorized")
		return
	}
	if a.cfg.DebugWebhooks {
		if d.VerificationToken != "" {
			raw = strings.ReplaceAll(raw, d.VerificationToken, "<redacted>")
		}
		log.Printf("kofi webhook (err=%v): %s", err, raw)
	}
	if err != nil || d.MessageID == "" {
		c.String(http.StatusBadRequest, "bad request")
		return
	}
	p := store.Payment{
		MessageID: d.MessageID, Txn: d.TxnID, Email: d.Email, Amount: d.Amount,
		Code: codeRe.FindString(strings.ToUpper(d.Message)),
	}
	if d.TierName != "" {
		p.Matches = append(p.Matches, d.TierName)
	}
	for _, it := range d.ShopItems {
		p.Matches = append(p.Matches, it.Code)
	}
	if err := a.store.ApplyPayment(p); err != nil {
		fail(c, err) // 500 makes Ko-fi retry; replays are idempotent
		return
	}
	a.stats.webhooks.Add(1)
	c.Status(http.StatusOK)
}

// --- admin: plans ---

func (a *API) admin(c *gin.Context) {
	ip := c.ClientIP()
	if a.badAdm.blocked(ip) {
		deny(c, http.StatusTooManyRequests, "too many requests")
		return
	}
	if subtle.ConstantTimeCompare([]byte(bearer(c)), []byte(a.cfg.AdminToken)) != 1 {
		a.badAdm.allow(ip) // records the failure
		a.stats.unauthorized.Add(1)
		deny(c, http.StatusUnauthorized, "unauthorized")
	}
}

func (a *API) adminList(c *gin.Context) {
	ps, err := a.store.Plans(false)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(200, ps)
}

func (a *API) adminPut(c *gin.Context) {
	p := store.Plan{Active: true}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
	if c.ShouldBindJSON(&p) != nil || p.Name == "" || p.KofiMatch == "" || p.Days < 0 {
		c.String(http.StatusBadRequest, "need name, kofiMatch, days>=0 (0 = lifetime)")
		return
	}
	p.Key = c.Param("key")
	if err := a.store.UpsertPlan(p); errors.Is(err, store.ErrConflict) {
		c.String(http.StatusConflict, err.Error())
	} else if err != nil {
		fail(c, err)
	} else {
		c.JSON(200, p)
	}
}

func (a *API) adminDelete(c *gin.Context) {
	ok, err := a.store.DeletePlan(c.Param("key"))
	if err != nil {
		fail(c, err)
	} else if !ok {
		c.Status(http.StatusNotFound)
	} else {
		c.Status(http.StatusNoContent)
	}
}
