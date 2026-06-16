package sidecar

import (
	"context"
	"fmt"
	"log"
	"runtime"
	"strings"
)

type Transport string

const (
	TransportUnix  Transport = "unix"
	TransportStdio Transport = "stdio"
)

type ResolvedBackend struct {
	Transport Transport
	Config    Config
}

func ResolveBackend(ctx context.Context, cfg Config, logger *log.Logger) (ResolvedBackend, error) {
	var failures []string

	if runtime.GOOS != "windows" {
		logger.Printf("checking Codex app-server Unix socket: %s", cfg.UnixSocket)
		if err := ProbeUnixBackend(ctx, cfg); err == nil {
			logger.Printf("selected upstream backend: unix (%s)", cfg.UnixSocket)
			return ResolvedBackend{Transport: TransportUnix, Config: cfg}, nil
		} else {
			failures = append(failures, fmt.Sprintf("unix %s: %v", cfg.UnixSocket, err))
			logger.Printf("Unix socket unavailable: %v", err)
		}
	} else {
		failures = append(failures, "unix: unavailable on Windows")
	}

	logger.Printf("checking Codex app-server stdio on this process stdin/stdout")
	if err := ProbeStdioBackend(); err == nil {
		logger.Printf("selected upstream backend: stdio (process stdin/stdout)")
		return ResolvedBackend{Transport: TransportStdio, Config: cfg}, nil
	} else {
		failures = append(failures, fmt.Sprintf("stdio stdin/stdout: %v", err))
		logger.Printf("stdio backend unavailable: %v", err)
	}

	return ResolvedBackend{}, fmt.Errorf("no usable Codex app-server transport found:\n  - %s", strings.Join(failures, "\n  - "))
}

func ProbeUnixBackend(ctx context.Context, cfg Config) error {
	probeCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	upstream, err := NewUnixWebSocketUpstream(probeCtx, cfg.UnixSocket)
	if err != nil {
		return err
	}
	return upstream.Close()
}

func ProbeStdioBackend() error {
	return StdioTransportAvailable(processStdin, processStdout)
}
