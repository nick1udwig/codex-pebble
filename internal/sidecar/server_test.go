package sidecar

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestServerBridgesMessagesAndAcceptsOrigin(t *testing.T) {
	upstream := newFakeUpstream()
	cfg := Config{Token: "secret"}
	server := httptest.NewServer(NewServerWithFactory(cfg, log.New(io.Discard, "", 0), func(context.Context) (Upstream, error) {
		return upstream, nil
	}))
	defer server.Close()

	addr := strings.TrimPrefix(server.URL, "http://")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws, err := DialTCPWebSocket(ctx, addr, "/?token=secret", http.Header{
		"Origin": {"http://pebble.local"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	if err := ws.WriteText([]byte(`{"id":1,"method":"ping"}`)); err != nil {
		t.Fatal(err)
	}

	select {
	case got := <-upstream.sent:
		if string(got) != `{"id":1,"method":"ping"}` {
			t.Fatalf("upstream got %q", got)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for upstream send")
	}

	upstream.recv <- []byte(`{"id":1,"result":"pong"}`)
	opcode, payload, err := ws.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if opcode != OpcodeText || string(payload) != `{"id":1,"result":"pong"}` {
		t.Fatalf("downstream got opcode=%x payload=%q", opcode, payload)
	}
}

func TestServerRejectsMissingToken(t *testing.T) {
	var called bool
	cfg := Config{Token: "secret"}
	server := httptest.NewServer(NewServerWithFactory(cfg, log.New(io.Discard, "", 0), func(context.Context) (Upstream, error) {
		called = true
		return newFakeUpstream(), nil
	}))
	defer server.Close()

	addr := strings.TrimPrefix(server.URL, "http://")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := DialTCPWebSocket(ctx, addr, "/", nil)
	if err == nil {
		t.Fatal("expected missing token to fail")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error = %v, want 401", err)
	}
	if called {
		t.Fatal("upstream factory was called for unauthorized client")
	}
}

func TestCLIHelp(t *testing.T) {
	var out bytes.Buffer
	exit := RunCLI([]string{"--help"}, &out, io.Discard)
	if exit != 0 {
		t.Fatalf("exit = %d, want 0", exit)
	}
	if !strings.Contains(out.String(), "codex-pebble-sidecar") {
		t.Fatalf("help output missing command name: %s", out.String())
	}
	if strings.Contains(out.String(), "--backend") {
		t.Fatalf("help output still advertises --backend: %s", out.String())
	}
}

type fakeUpstream struct {
	sent   chan []byte
	recv   chan []byte
	closed chan struct{}
	once   sync.Once
}

func newFakeUpstream() *fakeUpstream {
	return &fakeUpstream{
		sent:   make(chan []byte, 4),
		recv:   make(chan []byte, 4),
		closed: make(chan struct{}),
	}
}

func (f *fakeUpstream) Send(payload []byte) error {
	copied := append([]byte(nil), payload...)
	select {
	case f.sent <- copied:
		return nil
	case <-f.closed:
		return io.EOF
	}
}

func (f *fakeUpstream) Recv() ([]byte, error) {
	select {
	case payload := <-f.recv:
		return append([]byte(nil), payload...), nil
	case <-f.closed:
		return nil, io.EOF
	}
}

func (f *fakeUpstream) Close() error {
	f.once.Do(func() {
		close(f.closed)
	})
	return nil
}
