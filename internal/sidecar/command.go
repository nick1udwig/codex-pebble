package sidecar

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var Version = "dev"

func RunCLI(args []string, stdout, stderr io.Writer) int {
	logger := log.New(stderr, "", log.LstdFlags)
	cfg := Config{}

	flags := flag.NewFlagSet("codex-pebble-sidecar", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&cfg.ListenAddr, "listen", DefaultListenAddr, "TCP address for codex-pebble WebSocket clients")
	flags.StringVar(&cfg.Token, "token", "", "shared token required from clients as ?token=... or Bearer auth")
	flags.StringVar(&cfg.UnixSocket, "unix-socket", "", "Codex app-server Unix socket path to probe before stdio")
	timeout := flags.Duration("timeout", 10*time.Second, "upstream connect and shutdown timeout")
	showHelp := flags.Bool("help", false, "show help")
	showVersion := flags.Bool("version", false, "show version")

	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *showHelp {
		printUsage(flags, stdout)
		return 0
	}
	if *showVersion {
		fmt.Fprintf(stdout, "codex-pebble-sidecar %s\n", Version)
		return 0
	}

	cfg.Timeout = *timeout
	if err := cfg.Normalize(); err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if cfg.NeedsGeneratedToken() {
		token, err := GenerateToken()
		if err != nil {
			fmt.Fprintln(stderr, "error: generate token:", err)
			return 1
		}
		cfg.Token = token
	}

	backend, err := ResolveBackend(context.Background(), cfg, logger)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	cfg = backend.Config

	server := NewServer(backend, logger)
	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server,
		ReadHeaderTimeout: cfg.Timeout,
	}

	errc := make(chan error, 1)
	go func() {
		logger.Printf("codex-pebble sidecar listening on ws://%s", cfg.ListenAddr)
		if cfg.Token != "" {
			logger.Printf("client URL token: %s", cfg.Token)
		}
		switch backend.Transport {
		case TransportStdio:
			logger.Printf("upstream: process stdin/stdout")
		case TransportUnix:
			logger.Printf("upstream: %s", cfg.UnixSocket)
		}
		errc <- httpServer.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case sig := <-stop:
		logger.Printf("shutting down after %s", sig)
		ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			logger.Printf("shutdown failed: %v", err)
			return 1
		}
		return 0
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return 0
		}
		logger.Printf("server failed: %v", err)
		return 1
	}
}

func printUsage(flags *flag.FlagSet, out io.Writer) {
	fmt.Fprintln(out, "Usage: codex-pebble-sidecar [options]")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Examples:")
	fmt.Fprintln(out, "  codex-pebble-sidecar")
	fmt.Fprintln(out, "  codex-pebble-sidecar --listen 0.0.0.0:4501 --token secret")
	fmt.Fprintln(out, "  codex-pebble-sidecar --unix-socket ~/.codex/app-server-control/app-server-control.sock")
	fmt.Fprintln(out)
	flags.SetOutput(out)
	flags.PrintDefaults()
}
