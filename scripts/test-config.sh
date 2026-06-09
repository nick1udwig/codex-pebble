#!/usr/bin/env bash
set -euo pipefail

npx playwright test "$@"
