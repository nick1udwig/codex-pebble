package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestReadMessageRejectsOversizedControlFrame(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 126)
	frame := append([]byte{0x88, 126, 0, byte(len(payload))}, payload...)
	ws := &WebSocketConn{
		reader:     bufio.NewReader(bytes.NewReader(frame)),
		expectMask: false,
	}

	_, _, err := ws.ReadMessage()
	if err == nil {
		t.Fatal("expected oversized close control frame to fail")
	}
	if !strings.Contains(err.Error(), "control frame payload too large") {
		t.Fatalf("error = %v, want control frame payload error", err)
	}
}

func TestReadMessageRejectsReservedBits(t *testing.T) {
	ws := &WebSocketConn{
		reader:     bufio.NewReader(bytes.NewReader([]byte{0xC1, 0x00})),
		expectMask: false,
	}

	_, _, err := ws.ReadMessage()
	if err == nil {
		t.Fatal("expected frame with RSV bits to fail")
	}
	if !strings.Contains(err.Error(), "reserved bits") {
		t.Fatalf("error = %v, want reserved bits error", err)
	}
}

func TestReadMessageRejectsNonMinimalPayloadLengths(t *testing.T) {
	tests := []struct {
		name  string
		frame []byte
	}{
		{
			name:  "sixteen-bit length for small payload",
			frame: []byte{0x81, 126, 0, 125},
		},
		{
			name:  "sixty-four-bit length for sixteen-bit payload",
			frame: []byte{0x81, 127, 0, 0, 0, 0, 0, 0, 0, 126},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ws := &WebSocketConn{
				reader:     bufio.NewReader(bytes.NewReader(tt.frame)),
				expectMask: false,
			}

			_, _, err := ws.ReadMessage()
			if err == nil {
				t.Fatal("expected frame with non-minimal length to fail")
			}
			if !strings.Contains(err.Error(), "non-minimal") {
				t.Fatalf("error = %v, want non-minimal length error", err)
			}
		})
	}
}

func TestAcceptWebSocketRejectsInvalidKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := AcceptWebSocket(w, r)
		if err == nil {
			_ = ws.Close()
			t.Error("AcceptWebSocket accepted invalid Sec-WebSocket-Key")
		}
	}))
	defer server.Close()

	addr := strings.TrimPrefix(server.URL, "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	_, err = io.WriteString(conn, "GET / HTTP/1.1\r\n"+
		"Host: "+addr+"\r\n"+
		"Upgrade: websocket\r\n"+
		"Connection: Upgrade\r\n"+
		"Sec-WebSocket-Key: not-base64\r\n"+
		"Sec-WebSocket-Version: 13\r\n"+
		"\r\n")
	if err != nil {
		t.Fatal(err)
	}

	status, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(status, "400") {
		t.Fatalf("status = %q, want HTTP 400", strings.TrimSpace(status))
	}
}

func TestDialUnixWebSocketDoesNotSendOrigin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix sockets are not available on Windows")
	}

	socketPath := t.TempDir() + "/app-server.sock"
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	requestHead := make(chan string, 1)
	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		var lines []string
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
			lines = append(lines, line)
			if separator := strings.IndexByte(line, ':'); separator != -1 {
				headers[strings.ToLower(line[:separator])] = strings.TrimSpace(line[separator+1:])
			}
		}
		requestHead <- strings.Join(lines, "\n")

		key := headers["sec-websocket-key"]
		if key == "" {
			serverErr <- fmt.Errorf("missing Sec-WebSocket-Key")
			return
		}
		_, err = fmt.Fprintf(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", webSocketAccept(key))
		serverErr <- err
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, err := DialUnixWebSocket(ctx, socketPath, "/")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	select {
	case head := <-requestHead:
		if strings.Contains(strings.ToLower(head), "\norigin:") || strings.HasPrefix(strings.ToLower(head), "origin:") {
			t.Fatalf("handshake unexpectedly included Origin:\n%s", head)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for unix handshake")
	}

	select {
	case err := <-serverErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for unix handshake response")
	}
}
