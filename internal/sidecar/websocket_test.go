package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"net"
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
