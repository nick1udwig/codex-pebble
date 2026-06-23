package sidecar

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

const (
	OpcodeContinuation byte = 0x0
	OpcodeText         byte = 0x1
	OpcodeBinary       byte = 0x2
	OpcodeClose        byte = 0x8
	OpcodePing         byte = 0x9
	OpcodePong         byte = 0xA

	webSocketGUID   = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	maxMessageBytes = 8 << 20
)

type WebSocketConn struct {
	conn       net.Conn
	reader     *bufio.Reader
	maskWrites bool
	expectMask bool
	writeMu    sync.Mutex
}

func AcceptWebSocket(w http.ResponseWriter, r *http.Request) (*WebSocketConn, error) {
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		http.Error(w, "unsupported WebSocket version", http.StatusBadRequest)
		return nil, errors.New("unsupported WebSocket version")
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "response writer does not support hijacking", http.StatusInternalServerError)
		return nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}

	response := strings.Join([]string{
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Accept: " + webSocketAccept(key),
		"\r\n",
	}, "\r\n")
	if _, err := rw.WriteString(response); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}

	return &WebSocketConn{
		conn:       conn,
		reader:     rw.Reader,
		maskWrites: false,
		expectMask: true,
	}, nil
}

func DialUnixWebSocket(ctx context.Context, socketPath, requestPath string) (*WebSocketConn, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, err
	}
	return clientHandshake(ctx, conn, "localhost", requestPath)
}

func DialTCPWebSocket(ctx context.Context, addr, requestPath string, headers http.Header) (*WebSocketConn, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	return clientHandshakeWithHeaders(ctx, conn, addr, requestPath, headers)
}

func clientHandshake(ctx context.Context, conn net.Conn, host, requestPath string) (*WebSocketConn, error) {
	return clientHandshakeWithHeaders(ctx, conn, host, requestPath, nil)
}

func clientHandshakeWithHeaders(ctx context.Context, conn net.Conn, host, requestPath string, headers http.Header) (*WebSocketConn, error) {
	if requestPath == "" {
		requestPath = "/"
	}
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	defer close(done)

	var request strings.Builder
	request.WriteString("GET " + requestPath + " HTTP/1.1\r\n")
	request.WriteString("Host: " + host + "\r\n")
	request.WriteString("Upgrade: websocket\r\n")
	request.WriteString("Connection: Upgrade\r\n")
	request.WriteString("Sec-WebSocket-Key: " + key + "\r\n")
	request.WriteString("Sec-WebSocket-Version: 13\r\n")
	for name, values := range headers {
		for _, value := range values {
			request.WriteString(name + ": " + value + "\r\n")
		}
	}
	request.WriteString("\r\n")

	if _, err := io.WriteString(conn, request.String()); err != nil {
		_ = conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	status, responseHeaders, err := readHTTPResponseHead(reader)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if !strings.HasPrefix(status, "HTTP/1.1 101 ") && status != "HTTP/1.1 101" {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket upgrade failed: %s", status)
	}
	if responseHeaders.Get("Sec-WebSocket-Accept") != webSocketAccept(key) {
		_ = conn.Close()
		return nil, errors.New("websocket upgrade returned invalid Sec-WebSocket-Accept")
	}

	return &WebSocketConn{
		conn:       conn,
		reader:     reader,
		maskWrites: true,
		expectMask: false,
	}, nil
}

func readHTTPResponseHead(reader *bufio.Reader) (string, http.Header, error) {
	status, err := reader.ReadString('\n')
	if err != nil {
		return "", nil, err
	}
	status = strings.TrimRight(status, "\r\n")
	headers := make(http.Header)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return "", nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return status, headers, nil
		}
		separator := strings.IndexByte(line, ':')
		if separator == -1 {
			continue
		}
		headers.Add(strings.TrimSpace(line[:separator]), strings.TrimSpace(line[separator+1:]))
	}
}

func (c *WebSocketConn) ReadMessage() (byte, []byte, error) {
	var messageOpcode byte
	var message []byte
	fragmented := false

	for {
		frame, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}

		switch frame.opcode {
		case OpcodeText, OpcodeBinary:
			if fragmented {
				return 0, nil, errors.New("received new data frame before fragmented message completed")
			}
			if len(frame.payload) > maxMessageBytes {
				return 0, nil, errors.New("websocket message too large")
			}
			if frame.fin {
				return frame.opcode, frame.payload, nil
			}
			fragmented = true
			messageOpcode = frame.opcode
			message = append(message[:0], frame.payload...)
		case OpcodeContinuation:
			if !fragmented {
				return 0, nil, errors.New("received continuation frame without active message")
			}
			if len(message)+len(frame.payload) > maxMessageBytes {
				return 0, nil, errors.New("websocket message too large")
			}
			message = append(message, frame.payload...)
			if frame.fin {
				return messageOpcode, message, nil
			}
		case OpcodePing:
			if err := c.WriteControl(OpcodePong, frame.payload); err != nil {
				return 0, nil, err
			}
		case OpcodePong:
			continue
		case OpcodeClose:
			_ = c.WriteControl(OpcodeClose, frame.payload)
			return OpcodeClose, nil, io.EOF
		default:
			return 0, nil, fmt.Errorf("unsupported websocket opcode 0x%x", frame.opcode)
		}
	}
}

func (c *WebSocketConn) WriteText(payload []byte) error {
	return c.writeFrame(OpcodeText, payload)
}

func (c *WebSocketConn) WriteControl(opcode byte, payload []byte) error {
	if len(payload) > 125 {
		return errors.New("websocket control frame payload too large")
	}
	return c.writeFrame(opcode, payload)
}

func (c *WebSocketConn) Close() error {
	_ = c.WriteControl(OpcodeClose, nil)
	return c.conn.Close()
}

type wsFrame struct {
	fin     bool
	opcode  byte
	payload []byte
}

func (c *WebSocketConn) readFrame() (wsFrame, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.reader, header); err != nil {
		return wsFrame{}, err
	}

	first := header[0]
	second := header[1]
	if first&0x70 != 0 {
		return wsFrame{}, errors.New("websocket frame has reserved bits set")
	}
	fin := first&0x80 != 0
	opcode := first & 0x0f
	isControl := opcode >= OpcodeClose
	masked := second&0x80 != 0
	length := uint64(second & 0x7f)

	if c.expectMask && !masked {
		return wsFrame{}, errors.New("received unmasked websocket frame from client")
	}
	if !c.expectMask && masked {
		return wsFrame{}, errors.New("received masked websocket frame from server")
	}

	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return wsFrame{}, err
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
		if length < 126 {
			return wsFrame{}, errors.New("websocket frame has non-minimal payload length")
		}
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return wsFrame{}, err
		}
		length = binary.BigEndian.Uint64(extended[:])
		if length <= 0xffff {
			return wsFrame{}, errors.New("websocket frame has non-minimal payload length")
		}
		if length > maxMessageBytes {
			return wsFrame{}, errors.New("websocket frame too large")
		}
	}
	if isControl {
		if !fin {
			return wsFrame{}, errors.New("websocket control frame fragmented")
		}
		if length > 125 {
			return wsFrame{}, errors.New("websocket control frame payload too large")
		}
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
			return wsFrame{}, err
		}
	}
	if length > maxMessageBytes {
		return wsFrame{}, errors.New("websocket frame too large")
	}

	payload := make([]byte, int(length))
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return wsFrame{}, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return wsFrame{fin: fin, opcode: opcode, payload: payload}, nil
}

func (c *WebSocketConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	headerLen := 2
	length := len(payload)
	switch {
	case length < 126:
	case length <= 0xffff:
		headerLen += 2
	default:
		headerLen += 8
	}
	if c.maskWrites {
		headerLen += 4
	}

	frame := make([]byte, headerLen+length)
	offset := 0
	frame[offset] = 0x80 | opcode
	offset++

	maskBit := byte(0)
	if c.maskWrites {
		maskBit = 0x80
	}

	switch {
	case length < 126:
		frame[offset] = maskBit | byte(length)
		offset++
	case length <= 0xffff:
		frame[offset] = maskBit | 126
		offset++
		binary.BigEndian.PutUint16(frame[offset:offset+2], uint16(length))
		offset += 2
	default:
		frame[offset] = maskBit | 127
		offset++
		binary.BigEndian.PutUint64(frame[offset:offset+8], uint64(length))
		offset += 8
	}

	if !c.maskWrites {
		copy(frame[offset:], payload)
		_, err := c.conn.Write(frame)
		return err
	}

	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	copy(frame[offset:offset+4], mask[:])
	offset += 4
	for i := range payload {
		frame[offset+i] = payload[i] ^ mask[i%4]
	}
	_, err := c.conn.Write(frame)
	return err
}

func webSocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + webSocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}
