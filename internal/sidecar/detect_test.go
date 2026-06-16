package sidecar

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestResolveBackendPrefersUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix sockets are not available on Windows")
	}

	socketPath := t.TempDir() + "/app-server.sock"
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serveOneUnixWebSocket(t, listener)

	cfg := Config{UnixSocket: socketPath, Timeout: 2 * time.Second}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	backend, err := ResolveBackend(ctx, cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	if backend.Transport != TransportUnix {
		t.Fatalf("Transport = %q, want unix", backend.Transport)
	}
}

func TestResolveBackendFallsBackToStdio(t *testing.T) {
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdinReader.Close()
	defer stdinWriter.Close()
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutReader.Close()
	defer stdoutWriter.Close()

	restore := replaceProcessStdio(stdinReader, stdoutWriter)
	defer restore()

	cfg := Config{
		UnixSocket: t.TempDir() + "/missing.sock",
		Timeout:    2 * time.Second,
	}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	backend, err := ResolveBackend(ctx, cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	if backend.Transport != TransportStdio {
		t.Fatalf("Transport = %q, want stdio", backend.Transport)
	}
}

func TestResolveBackendErrorsWhenNoTransportWorks(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "stdio")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	restore := replaceProcessStdio(file, file)
	defer restore()

	cfg := Config{
		UnixSocket: t.TempDir() + "/missing.sock",
		Timeout:    2 * time.Second,
	}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = ResolveBackend(ctx, cfg, log.New(io.Discard, "", 0))
	if err == nil {
		t.Fatal("expected ResolveBackend to fail")
	}
	if !strings.Contains(err.Error(), "no usable Codex app-server transport found") {
		t.Fatalf("error = %v", err)
	}
}

func replaceProcessStdio(stdin, stdout *os.File) func() {
	oldStdin := processStdin
	oldStdout := processStdout
	processStdin = stdin
	processStdout = stdout
	return func() {
		processStdin = oldStdin
		processStdout = oldStdout
	}
}

func serveOneUnixWebSocket(t *testing.T, listener net.Listener) {
	t.Helper()
	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		headers := map[string]string{}
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				serverErr <- err
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				break
			}
			if separator := strings.IndexByte(line, ':'); separator != -1 {
				headers[strings.ToLower(line[:separator])] = strings.TrimSpace(line[separator+1:])
			}
		}

		key := headers["sec-websocket-key"]
		if key == "" {
			serverErr <- fmt.Errorf("missing Sec-WebSocket-Key")
			return
		}
		_, err = fmt.Fprintf(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", webSocketAccept(key))
		serverErr <- err
	}()

	t.Cleanup(func() {
		select {
		case err := <-serverErr:
			if err != nil {
				t.Errorf("unix test server failed: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("timed out waiting for unix test server")
		}
	})
}
