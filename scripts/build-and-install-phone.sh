#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PBW_PATH="${CODEX_PEBBLE_PHONE_PBW:-build/codex-pebble.pbw}"
CONFIG_URL_DEFAULT="https://nick1udwig.github.io/codex-pebble/config/?v=20260609-return-to"

cd "$ROOT_DIR"

CONFIG_URL="$(
  sed -n 's/^var CONFIG_URL = "\(.*\)";$/\1/p' src/pkjs/index.js | tail -n 1
)"
CONFIG_URL="${CONFIG_URL:-$CONFIG_URL_DEFAULT}"

echo "Building Codex Pebble dev PBW."
echo "Config URL: $CONFIG_URL"
echo "Output PBW: $PBW_PATH"

if [[ "${CODEX_PEBBLE_DRY_RUN:-0}" == "1" ]]; then
  echo "Dry run enabled; skipping build and phone install."
  exit 0
fi

npm run build:watch

if [[ ! -f "$PBW_PATH" ]]; then
  echo "Expected PBW not found: $PBW_PATH" >&2
  exit 1
fi

echo "Installing $PBW_PATH to the paired phone..."
pebble install "$PBW_PATH" --phone
