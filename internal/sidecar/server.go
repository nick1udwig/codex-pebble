package sidecar

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
)

type Upstream interface {
	Send([]byte) error
	Recv() ([]byte, error)
	Close() error
}

type UpstreamFactory func(context.Context) (Upstream, error)

type Server struct {
	backend ResolvedBackend
	logger  *log.Logger
	factory UpstreamFactory
	active  atomic.Bool
}

func NewServer(backend ResolvedBackend, logger *log.Logger) *Server {
	return &Server{
		backend: backend,
		logger:  logger,
		factory: defaultUpstreamFactory(backend),
	}
}

func NewServerWithFactory(cfg Config, logger *log.Logger, factory UpstreamFactory) *Server {
	return &Server{
		backend: ResolvedBackend{Transport: TransportUnix, Config: cfg},
		logger:  logger,
		factory: factory,
	}
}

func defaultUpstreamFactory(backend ResolvedBackend) UpstreamFactory {
	return func(ctx context.Context) (Upstream, error) {
		switch backend.Transport {
		case TransportStdio:
			return NewProcessStdioUpstream(), nil
		case TransportUnix:
			return NewUnixWebSocketUpstream(ctx, backend.Config.UnixSocket)
		default:
			return nil, fmt.Errorf("unsupported backend %q", backend.Transport)
		}
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz", "/readyz":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
		return
	}

	if !isWebSocketRequest(r) {
		http.Error(w, "codex-pebble sidecar expects a WebSocket upgrade", http.StatusBadRequest)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !s.active.CompareAndSwap(false, true) {
		http.Error(w, "another codex-pebble client is already connected", http.StatusConflict)
		return
	}
	defer s.active.Store(false)

	upstream, err := s.factory(r.Context())
	if err != nil {
		s.logger.Printf("upstream connect failed: %v", err)
		http.Error(w, "upstream connect failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	downstream, err := AcceptWebSocket(w, r)
	if err != nil {
		_ = upstream.Close()
		s.logger.Printf("downstream upgrade failed: %v", err)
		return
	}
	defer downstream.Close()

	s.logger.Printf("client connected from %s", r.RemoteAddr)
	err = bridge(r.Context(), downstream, upstream)
	if err != nil && !isExpectedClose(err) {
		s.logger.Printf("client session ended with error: %v", err)
	} else {
		s.logger.Printf("client disconnected")
	}
}

func (s *Server) authorized(r *http.Request) bool {
	if s.backend.Config.Token == "" {
		return true
	}
	if r.URL.Query().Get("token") == s.backend.Config.Token {
		return true
	}
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") && strings.TrimSpace(auth[len("Bearer "):]) == s.backend.Config.Token {
		return true
	}
	for _, protocol := range parseHeaderTokens(r.Header.Values("Sec-WebSocket-Protocol")) {
		if protocol == "codex-pebble-token."+s.backend.Config.Token {
			return true
		}
	}
	return false
}

func isWebSocketRequest(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		headerContains(r.Header.Values("Connection"), "upgrade")
}

func headerContains(values []string, want string) bool {
	want = strings.ToLower(want)
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if strings.ToLower(strings.TrimSpace(part)) == want {
				return true
			}
		}
	}
	return false
}

func parseHeaderTokens(values []string) []string {
	var out []string
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

func bridge(ctx context.Context, downstream *WebSocketConn, upstream Upstream) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	errc := make(chan error, 2)
	go func() {
		for {
			opcode, payload, err := downstream.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			if opcode != OpcodeText && opcode != OpcodeBinary {
				continue
			}
			if err := upstream.Send(payload); err != nil {
				errc <- err
				return
			}
		}
	}()

	go func() {
		for {
			payload, err := upstream.Recv()
			if err != nil {
				errc <- err
				return
			}
			if err := downstream.WriteText(payload); err != nil {
				errc <- err
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		_ = downstream.Close()
		_ = upstream.Close()
		return ctx.Err()
	case err := <-errc:
		_ = downstream.Close()
		_ = upstream.Close()
		return err
	}
}

func isExpectedClose(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, context.Canceled)
}
