package config

import (
	"errors"
	"os"
)

type Config struct {
	Addr           string // listen address
	DB             string
	KofiToken      string // Ko-fi "verification token" from the webhook settings page
	AdminToken     string // empty disables /admin
	ClientIPHeader string // e.g. "Fly-Client-IP" or "X-Forwarded-For" when behind a proxy; empty = RemoteAddr
	DebugWebhooks  bool   // log each Ko-fi payload (token redacted, but it contains emails): debugging only
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func Load() (Config, error) {
	c := Config{
		Addr:           env("ADDR", ":8080"),
		DB:             env("DATABASE_URL", env("DB_PATH", "tgsd.db")),
		KofiToken:      os.Getenv("KOFI_VERIFICATION_TOKEN"),
		AdminToken:     os.Getenv("ADMIN_TOKEN"),
		ClientIPHeader: os.Getenv("CLIENT_IP_HEADER"),
		DebugWebhooks:  os.Getenv("DEBUG_WEBHOOKS") == "1",
	}
	if c.KofiToken == "" {
		return c, errors.New("KOFI_VERIFICATION_TOKEN is required")
	}
	if c.AdminToken != "" && len(c.AdminToken) < 32 {
		return c, errors.New("ADMIN_TOKEN must be at least 32 chars (or empty to disable /admin)")
	}
	return c, nil
}
