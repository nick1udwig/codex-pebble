#!/usr/bin/env bash
set -Eeuo pipefail

current_step=""

report_failure() {
  local exit_code="$1"
  local failed_command="$2"
  local failed_line="$3"
  if [[ -n "${current_step}" ]]; then
    echo "ERROR: pre-release gate failed during: ${current_step}" >&2
  fi
  echo "ERROR: command failed at line ${failed_line}: ${failed_command}" >&2
  exit "${exit_code}"
}

trap 'report_failure $? "$BASH_COMMAND" "$LINENO"' ERR

run_step() {
  current_step="$1"
  shift
  printf '\n==> %s\n' "${current_step}"
  "$@"
}

run_step "JS tests" npm run test:js
run_step "Config-page tests" npm run test:config
run_step "Sidecar tests" npm run test:sidecar
run_step "Watch build" npm run test:build
run_step "Static config copy" npm run build:config:docs

echo "Pre-release local test pass completed."
