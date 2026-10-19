package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"tgramsave/backend/internal/config"
	"tgramsave/backend/internal/httpapi"
	"tgramsave/backend/internal/store"
)

func main() {
	var addr, db string
	serve := &cobra.Command{
		Use:   "serve",
		Short: "Run the HTTP server",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if cmd.Flags().Changed("addr") {
				cfg.Addr = addr
			}
			if cmd.Flags().Changed("db") {
				cfg.DB = db
			}
			return run(cmd.Context(), cfg)
		},
	}
	serve.Flags().StringVar(&addr, "addr", "", "listen address (env ADDR, default :8080)")
	serve.Flags().StringVar(&db, "db", "", "Postgres URL or SQLite path (env DATABASE_URL or DB_PATH)")

	root := &cobra.Command{Use: "tgsd", Short: "TGramSave backend", SilenceUsage: true}
	root.AddCommand(serve)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := root.ExecuteContext(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, cfg config.Config) error {
	s, err := store.Open(cfg.DB)
	if err != nil {
		return err
	}
	defer s.Close()
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.New(cfg, s),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(sc)
	}()
	log.Printf("listening on %s (admin %v)", cfg.Addr, cfg.AdminToken != "")
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
