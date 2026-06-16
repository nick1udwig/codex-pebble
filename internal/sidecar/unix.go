package sidecar

import "context"

type UnixWebSocketUpstream struct {
	ws *WebSocketConn
}

func NewUnixWebSocketUpstream(ctx context.Context, socketPath string) (*UnixWebSocketUpstream, error) {
	ws, err := DialUnixWebSocket(ctx, socketPath, "/")
	if err != nil {
		return nil, err
	}
	return &UnixWebSocketUpstream{ws: ws}, nil
}

func (u *UnixWebSocketUpstream) Send(payload []byte) error {
	return u.ws.WriteText(payload)
}

func (u *UnixWebSocketUpstream) Recv() ([]byte, error) {
	for {
		opcode, payload, err := u.ws.ReadMessage()
		if err != nil {
			return nil, err
		}
		if opcode == OpcodeText || opcode == OpcodeBinary {
			return payload, nil
		}
	}
}

func (u *UnixWebSocketUpstream) Close() error {
	return u.ws.Close()
}
