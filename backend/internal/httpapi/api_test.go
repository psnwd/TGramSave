package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tgramsave/backend/internal/config"
	"tgramsave/backend/internal/store"
)

func setup(t *testing.T) http.Handler {
	dsn := filepath.Join(t.TempDir(), "t.db")
	if u := os.Getenv("TEST_DATABASE_URL"); u != "" { // run the suite against Postgres; tables are dropped first
		store.Reset(u)
		dsn = u
	}
	s, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return New(config.Config{KofiToken: "ktok", AdminToken: "adm"}, s)
}

func do(h http.Handler, method, path, auth, body string, form bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if form {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if auth != "" {
		r.Header.Set("Authorization", "Bearer "+auth)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func kofi(h http.Handler, data string) int {
	return do(h, "POST", "/webhooks/kofi", "", url.Values{"data": {data}}.Encode(), true).Code
}

func statusOf(t *testing.T, h http.Handler, secret string) statusResp {
	var s statusResp
	json.Unmarshal(do(h, "GET", "/v1/status", secret, "", false).Body.Bytes(), &s)
	return s
}

func TestFlow(t *testing.T) {
	h := setup(t)
	var reg map[string]string
	json.Unmarshal(do(h, "POST", "/v1/register", "", "", false).Body.Bytes(), &reg)
	sec, code := reg["secret"], reg["code"]
	if statusOf(t, h, sec).Tier != "free" || do(h, "GET", "/v1/status", "bad", "", false).Code != 401 {
		t.Fatal("new install should be free, bad secret 401")
	}

	// bad verification token rejected
	if kofi(h, `{"verification_token":"x","message_id":"m0"}`) != 401 {
		t.Fatal("bad token must be 401")
	}
	// first subscription payment: code in message activates
	first := `{"verification_token":"ktok","message_id":"m1","email":"A@x.com","tier_name":"monthly","message":"hi ` + strings.ToLower(code) + `"}`
	if kofi(h, first) != 200 || statusOf(t, h, sec).Tier != "premium" {
		t.Fatal("code in message should activate")
	}
	exp := *statusOf(t, h, sec).ExpiresAt
	// replay is idempotent
	kofi(h, first)
	if *statusOf(t, h, sec).ExpiresAt != exp {
		t.Fatal("replay extended premium")
	}
	// renewal without code matches by email
	kofi(h, `{"verification_token":"ktok","message_id":"m2","email":"a@x.com","tier_name":"Monthly"}`)
	if *statusOf(t, h, sec).ExpiresAt != exp+35*86400 {
		t.Fatal("renewal by email should extend 35d")
	}
	// lifetime shop order
	kofi(h, `{"verification_token":"ktok","message_id":"m3","email":"a@x.com","shop_items":[{"direct_link_code":"lifetime"}]}`)
	if !statusOf(t, h, sec).Lifetime {
		t.Fatal("lifetime expected")
	}
}

func TestClaimAndAdmin(t *testing.T) {
	h := setup(t)
	// pay before any install knows the email, no code
	kofi(h, `{"verification_token":"ktok","message_id":"m1","email":"b@x.com","shop_items":[{"direct_link_code":"quarterly"}]}`)
	var reg map[string]string
	json.Unmarshal(do(h, "POST", "/v1/register", "", "", false).Body.Bytes(), &reg)
	if statusOf(t, h, reg["secret"]).Tier != "free" {
		t.Fatal("unclaimed should be free")
	}
	do(h, "POST", "/v1/claim", reg["secret"], `{"email":"B@x.com"}`, false)
	if statusOf(t, h, reg["secret"]).Tier != "premium" {
		t.Fatal("claim should activate")
	}

	// admin: token required, edit price, change days, public list reflects it
	if do(h, "GET", "/admin/plans", "nope", "", false).Code != 401 {
		t.Fatal("admin needs token")
	}
	if do(h, "PUT", "/admin/plans/yearly", "adm", `{"name":"Yearly","kofiMatch":"yearly","days":365,"price":"$19.99"}`, false).Code != 200 {
		t.Fatal("create plan")
	}
	if do(h, "PUT", "/admin/plans/dup", "adm", `{"name":"D","kofiMatch":"YEARLY","days":1}`, false).Code != 409 {
		t.Fatal("duplicate kofiMatch should 409")
	}
	do(h, "PUT", "/admin/plans/monthly", "adm", `{"name":"Monthly","kofiMatch":"Monthly","days":35,"price":"$2.99/mo","active":false}`, false)
	if b := do(h, "GET", "/v1/plans", "", "", false).Body.String(); strings.Contains(b, "Monthly") || !strings.Contains(b, "Yearly") {
		t.Fatalf("public plans wrong: %s", b)
	}
	if do(h, "DELETE", "/admin/plans/yearly", "adm", "", false).Code != 204 {
		t.Fatal("delete plan")
	}
}

func TestHardening(t *testing.T) {
	h := setup(t)
	w := do(h, "GET", "/healthz", "", "", false)
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Strict-Transport-Security") == "" {
		t.Fatal("security headers missing")
	}
	var reg map[string]string
	json.Unmarshal(do(h, "POST", "/v1/register", "", "", false).Body.Bytes(), &reg)
	if do(h, "POST", "/v1/claim", reg["secret"], `{"email":"not-an-email"}`, false).Code != 400 {
		t.Fatal("bad email must 400")
	}
	// raw token without the Bearer prefix is not accepted
	r := httptest.NewRequest("GET", "/v1/status", nil)
	r.Header.Set("Authorization", reg["secret"])
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != 401 {
		t.Fatal("prefixless token must 401")
	}
	// admin brute force locks out, even for the right token
	for range 10 {
		do(h, "GET", "/admin/plans", "wrong", "", false)
	}
	if do(h, "GET", "/admin/plans", "adm", "", false).Code != 429 {
		t.Fatal("admin must lock out after repeated failures")
	}
}
