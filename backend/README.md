# TGramSave backend

Go + Gin + Cobra + GORM; SQLite by default, Postgres via `DATABASE_URL`. Receives Ko-fi webhooks, tells the extension its tier.

Run: `KOFI_VERIFICATION_TOKEN=... ADMIN_TOKEN=... go run ./cmd/tgsd serve` (flags `--addr`, `--db`) · Test: `go test ./...` · Docker: `docker build -t tgsd .` (mount a volume at `/data`).

## Flow
1. Extension `POST /v1/register` → `{id, secret, code}` (`code` = `TGS-XXXX-XXXX`). Keeps `secret` locally.
2. User pays on Ko-fi and pastes `code` into the Ko-fi message box.
3. Ko-fi `POST /webhooks/kofi` (set URL in Ko-fi webhooks) → code matched → install upgraded. Renewals have no code, matched by the email recorded on first payment.
4. Extension `GET /v1/status` (`Authorization: Bearer <secret>`). Forgot the code? `POST /v1/claim {"email":"...","txn":"<Ko-fi transaction id>"}`.
   The transaction id is the proof of ownership. Email-only restore is off by default; set `ALLOW_EMAIL_CLAIM=1` to restore the legacy behaviour (less secure).

## Public
`GET /v1/plans` active plans (prices for the popup) · `GET /healthz` liveness · `GET /readyz` database readiness.

## Admin (needs `ADMIN_TOKEN`, `Authorization: Bearer <token>`)
```
GET    /admin/plans
PUT    /admin/plans/{key}   {"name":"Monthly","kofiMatch":"<Ko-fi tier name or shop direct_link_code>","days":35,"price":"$3.99/mo","active":true}
DELETE /admin/plans/{key}
GET    /admin/metrics       counters: registers, claims, webhooks, unauthorized, rateLimited
```
`days: 0` = lifetime. `kofiMatch` must equal the Ko-fi membership tier name or shop item direct link code (case-insensitive, unique). Seeded placeholders: monthly / quarterly / lifetime. Existing subscribers keep their paid time when a plan is edited; new payments use the new `days`.

## Schema changes
`store.Open` runs GORM `AutoMigrate` plus two expression/partial indexes. That is fine for this single-instance service and both SQLite/Postgres, but it is not a substitute for reviewable migrations if the schema starts changing often. Document any destructive change and take a backup first.

## Limits (deliberate)
Single instance, in-memory rate limits, transaction-id claim (email-only is opt-in). Ko-fi sends no cancel event, so monthly `days` includes ~5 days grace. SQLite runs with one writer connection; use `DATABASE_URL` for Postgres when scaling.

## Backups
SQLite: stop the container and copy the volume (`/data/tgsd.db` plus `-wal`/`-shm` if present), or use `sqlite3 .backup`. Postgres: `pg_dump`. Test a restore before relying on it.
