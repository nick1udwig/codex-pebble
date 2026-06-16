package sidecar

import "testing"

func TestNormalizeDefaultsToAuto(t *testing.T) {
	cfg := Config{}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != DefaultListenAddr {
		t.Fatalf("ListenAddr = %q, want %q", cfg.ListenAddr, DefaultListenAddr)
	}
}

func TestNormalizeKeepsAutoWhenSocketSet(t *testing.T) {
	cfg := Config{UnixSocket: "/tmp/codex.sock"}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}
	if cfg.UnixSocket != "/tmp/codex.sock" {
		t.Fatalf("UnixSocket = %q, want /tmp/codex.sock", cfg.UnixSocket)
	}
}

func TestNeedsGeneratedTokenForNonLoopbackListenAddr(t *testing.T) {
	tests := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:4501", false},
		{"localhost:4501", false},
		{"[::1]:4501", false},
		{"0.0.0.0:4501", true},
		{"192.168.1.10:4501", true},
	}

	for _, tt := range tests {
		cfg := Config{ListenAddr: tt.addr}
		if got := cfg.NeedsGeneratedToken(); got != tt.want {
			t.Fatalf("NeedsGeneratedToken(%q) = %v, want %v", tt.addr, got, tt.want)
		}
	}
}
