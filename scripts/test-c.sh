#!/usr/bin/env bash
set -euo pipefail

mkdir -p build/tests
cc -std=c11 -Wall -Wextra -Werror=return-type -Wno-unused-function -Wno-unused-parameter \
  -I tests/c \
  tests/c/main_test.c \
  -o build/tests/c-watch-logic
build/tests/c-watch-logic
