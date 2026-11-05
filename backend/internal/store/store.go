package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

// Lifetime is premium_until for lifetime plans (year 9999).
const Lifetime int64 = 253402300799

var ErrConflict = errors.New("kofi_match already used by another plan")
var ErrProofRequired = errors.New("ko-fi transaction id required to claim a payment")

type Plan struct {
	Key       string `json:"key" gorm:"primaryKey"`
	Name      string `json:"name" gorm:"not null"`
	KofiMatch string `json:"kofiMatch" gorm:"not null"` // Ko-fi tier name or shop direct_link_code, case-insensitive
	Days      int    `json:"days" gorm:"not null"`      // 0 = lifetime
	Price     string `json:"price" gorm:"not null;default:''"`
	Active    bool   `json:"active" gorm:"not null"`
}

type Install struct {
	ID           string `gorm:"primaryKey"`
	SecretHash   string `gorm:"not null;uniqueIndex"`
	Code         string `gorm:"not null;uniqueIndex"`
	Email        string `gorm:"not null;default:'';index"`
	PremiumUntil int64  `gorm:"not null;default:0"` // unix seconds
	CreatedAt    int64  `gorm:"not null"`
}

// dbPayment is the payments row; message_id (Ko-fi) makes webhook retries idempotent.
type dbPayment struct {
	MessageID string  `gorm:"primaryKey"`
	KofiTxn   string  `gorm:"not null"`
	Email     string  `gorm:"not null;index"`
	Amount    string  `gorm:"not null"`
	PlanKey   *string // nil = no plan matched
	InstallID *string // nil = not yet claimed
	CreatedAt int64   `gorm:"not null"`
}

func (dbPayment) TableName() string { return "payments" }

type Payment struct {
	MessageID, Txn, Email, Amount string
	Code                          string   // activation code found in the Ko-fi message, if any
	Matches                       []string // tier name / shop item codes to look up as plans
}

type Store struct{ db *gorm.DB }

// Open takes a Postgres URL (postgres://...) or a SQLite file path.
func Open(dsn string) (*Store, error) {
	cfg := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}
	var db *gorm.DB
	var err error
	pg := strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://")
	if pg {
		db, err = gorm.Open(postgres.Open(dsn), cfg)
	} else {
		db, err = gorm.Open(sqlite.Open("file:"+dsn+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"), cfg)
	}
	if err != nil {
		return nil, err
	}
	if !pg {
		sqlDB, _ := db.DB()
		sqlDB.SetMaxOpenConns(1) // ponytail: SQLite = one writer; Postgres has no such limit
	}
	if err := db.AutoMigrate(&Plan{}, &Install{}, &dbPayment{}); err != nil {
		return nil, err
	}
	// Expression/partial indexes: GORM tags can't express these; syntax is valid on both SQLite and Postgres.
	for _, q := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS plans_kofi_match ON plans(lower(kofi_match))`,
		`CREATE INDEX IF NOT EXISTS payments_unclaimed ON payments(email) WHERE install_id IS NULL AND plan_key IS NOT NULL`,
	} {
		if err := db.Exec(q).Error; err != nil {
			return nil, err
		}
	}
	// Placeholder plans: edit via /admin/plans. kofi_match must equal your real Ko-fi tier name / shop item direct link code.
	seed := []Plan{
		{Key: "monthly", Name: "Monthly", KofiMatch: "Monthly", Days: 35, Price: "$3.99/mo", Active: true},
		{Key: "quarterly", Name: "Quarterly", KofiMatch: "quarterly", Days: 90, Price: "$9.99", Active: true},
		{Key: "lifetime", Name: "Lifetime", KofiMatch: "lifetime", Days: 0, Price: "$29.99", Active: true},
	}
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&seed).Error; err != nil {
		return nil, err
	}
	return &Store{db}, nil
}

func (s *Store) Close() error {
	d, err := s.db.DB()
	if err != nil {
		return err
	}
	return d.Close()
}

// Ping is the readiness check: SQLite/Postgres reachable and accepting queries.
func (s *Store) Ping(ctx context.Context) error {
	d, err := s.db.DB()
	if err != nil {
		return err
	}
	return d.PingContext(ctx)
}

func hash(secret string) string {
	h := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(h[:])
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func randStr(n int, alphabet string) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // no entropy: never hand out predictable secrets
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// CreateInstall returns the plaintext secret (only time it is visible) and the activation code.
func (s *Store) CreateInstall() (id, secret, code string, err error) {
	id, secret = randStr(24, "0123456789abcdef"), randStr(48, "0123456789abcdef")
	code = "TGS-" + randStr(4, codeAlphabet) + "-" + randStr(4, codeAlphabet)
	err = s.db.Create(&Install{ID: id, SecretHash: hash(secret), Code: code, CreatedAt: time.Now().Unix()}).Error
	return
}

func (s *Store) InstallBySecret(secret string) (*Install, error) {
	return first[Install](s.db.Where("secret_hash = ?", hash(secret)))
}

// first returns nil, nil when no row matches.
func first[T any](q *gorm.DB) (*T, error) {
	var v T
	err := q.Take(&v).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &v, err
}

// --- plans (admin-editable) ---

func (s *Store) Plans(activeOnly bool) ([]Plan, error) {
	q := s.db.Order("days = 0").Order("days")
	if activeOnly {
		q = q.Where("active = ?", true)
	}
	out := []Plan{}
	return out, q.Find(&out).Error
}

func (s *Store) UpsertPlan(p Plan) error {
	err := s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"name", "kofi_match", "days", "price", "active"}),
	}).Select("*").Create(&p).Error
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return ErrConflict
	}
	return err
}

func (s *Store) DeletePlan(key string) (bool, error) {
	r := s.db.Delete(&Plan{}, "key = ?", key)
	return r.RowsAffected > 0, r.Error
}

// --- payments ---

// ApplyPayment records a Ko-fi payment once (by message_id) and activates the matching install:
// by activation code first, else by the email of a previously activated install (renewals carry no code).
// With no install found the payment stays unclaimed until Claim.
func (s *Store) ApplyPayment(p Payment) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now().Unix()
		email := strings.ToLower(strings.TrimSpace(p.Email))

		var plan *Plan
		for _, m := range p.Matches {
			var err error
			if plan, err = first[Plan](tx.Where("active = ? AND lower(kofi_match) = lower(?)", true, m)); err != nil {
				return err
			} else if plan != nil {
				break
			}
		}
		row := dbPayment{MessageID: p.MessageID, KofiTxn: p.Txn, Email: email, Amount: p.Amount, CreatedAt: now}
		if plan != nil {
			row.PlanKey = &plan.Key
		}
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 || plan == nil {
			return nil // replay, or no plan matches (donation etc.)
		}

		var inst *Install
		var err error
		if p.Code != "" {
			if inst, err = first[Install](tx.Where("code = ?", p.Code)); err != nil {
				return err
			}
		}
		if inst == nil && email != "" {
			if inst, err = first[Install](tx.Where("email = ?", email).Order("created_at DESC")); err != nil {
				return err
			}
		}
		if inst != nil {
			return activate(tx, inst.ID, plan.Days, email, p.MessageID, now)
		}
		return nil
	})
}

// Claim binds unclaimed payments to the install. Proof is the Ko-fi transaction id shown on the receipt;
// the legacy email-only path is opt-in via ALLOW_EMAIL_CLAIM=1 (someone who knows an email is not the
// owner). Payments bind once and the endpoint is rate-limited.
func (s *Store) Claim(installID, email, txn string, allowEmail bool) error {
	email = strings.ToLower(strings.TrimSpace(email))
	txn = strings.TrimSpace(txn)
	if email == "" {
		return nil
	}
	if txn == "" && !allowEmail {
		return ErrProofRequired
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		var cs []struct {
			MessageID string
			Days      int
		}
		query := `SELECT p.message_id, pl.days FROM payments p JOIN plans pl ON pl.key = p.plan_key
			WHERE p.email = ? AND p.install_id IS NULL`
		args := []any{email}
		if txn != "" {
			query += ` AND p.kofi_txn = ?`
			args = append(args, txn)
		}
		err := tx.Raw(query, args...).Scan(&cs).Error
		if err != nil {
			return err
		}
		now := time.Now().Unix()
		for _, c := range cs {
			if err := activate(tx, installID, c.Days, email, c.MessageID, now); err != nil {
				return err
			}
		}
		return nil
	})
}

func activate(tx *gorm.DB, installID string, days int, email, msgID string, now int64) error {
	var inst Install
	// Row lock on Postgres so concurrent payments for one install can't lose an extension (SQLite ignores it: single writer).
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&inst, "id = ?", installID).Error; err != nil {
		return err
	}
	until := inst.PremiumUntil
	if days == 0 {
		until = Lifetime
	} else if until != Lifetime {
		until = max(until, now) + int64(days)*86400
	}
	upd := map[string]any{"premium_until": until}
	if email != "" {
		upd["email"] = email
	}
	if err := tx.Model(&Install{}).Where("id = ?", installID).Updates(upd).Error; err != nil {
		return err
	}
	return tx.Model(&dbPayment{}).Where("message_id = ?", msgID).Update("install_id", installID).Error
}

// ResetForTests drops all tables in the database at dsn. Test helper only — never call from production code.
func ResetForTests(dsn string) {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		panic(err)
	}
	db.Migrator().DropTable(&Plan{}, &Install{}, &dbPayment{})
}
