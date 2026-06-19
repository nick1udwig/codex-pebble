package sidecar

import (
	"crypto/rand"
	"encoding/base64"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultListenAddr = "0.0.0.0:4501"
	DefaultUnixSocket = "~/.codex/app-server-control/app-server-control.sock"
)

type Config struct {
	ListenAddr string
	Token      string

	UnixSocket string
	Timeout    time.Duration
}

func (c *Config) Normalize() error {
	if c.ListenAddr == "" {
		c.ListenAddr = DefaultListenAddr
	}
	if c.UnixSocket == "" {
		c.UnixSocket = DefaultUnixSocket
	}
	expanded, err := ExpandHome(c.UnixSocket)
	if err != nil {
		return err
	}
	c.UnixSocket = expanded

	if c.Timeout <= 0 {
		c.Timeout = 10 * time.Second
	}
	return nil
}

func (c Config) NeedsGeneratedToken() bool {
	return c.Token == "" && !IsLoopbackListenAddr(c.ListenAddr)
}

func GenerateToken() (string, error) {
	var buf [24]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func ExpandHome(path string) (string, error) {
	if path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return home, nil
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}

func IsLoopbackListenAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "" || host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
