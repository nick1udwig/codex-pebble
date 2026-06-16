package main

import (
	"os"

	"github.com/nick1udwig/codex-pebble/internal/sidecar"
)

func main() {
	os.Exit(sidecar.RunCLI(os.Args[1:], os.Stdout, os.Stderr))
}
