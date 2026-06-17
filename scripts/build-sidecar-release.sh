#!/usr/bin/env bash
set -Eeuo pipefail

version="${1:-dev}"
out_dir="${2:-build/sidecar-release}"
module_path="github.com/nick1udwig/codex-pebble/internal/sidecar"
cache_dir="${CODEX_PEBBLE_RELEASE_CACHE_DIR:-build/.cache}"
if [[ "${cache_dir}" != /* ]]; then
  cache_dir="${PWD}/${cache_dir}"
fi

export GOCACHE="${GOCACHE:-${cache_dir}/go-build}"
export GOMODCACHE="${GOMODCACHE:-${cache_dir}/go-mod}"

rm -rf "${out_dir}"
mkdir -p "${out_dir}" "${GOCACHE}" "${GOMODCACHE}"

build_one() {
  local goos="$1"
  local goarch="$2"
  local exe_suffix=""
  local archive
  local package_name="codex-pebble-sidecar-${version}-${goos}-${goarch}"
  local package_dir="${out_dir}/${package_name}"

  if [[ "${goos}" == "windows" ]]; then
    exe_suffix=".exe"
  fi

  mkdir -p "${package_dir}"
  CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
    go build \
      -trimpath \
      -ldflags "-s -w -X ${module_path}.Version=${version}" \
      -o "${package_dir}/codex-pebble-sidecar${exe_suffix}" \
      ./cmd/codex-pebble-sidecar

  if [[ "${goos}" == "windows" ]]; then
    archive="${out_dir}/${package_name}.zip"
    (cd "${out_dir}" && zip -q -r "$(basename "${archive}")" "${package_name}")
  else
    archive="${out_dir}/${package_name}.tar.gz"
    tar -C "${out_dir}" -czf "${archive}" "${package_name}"
  fi

  rm -rf "${package_dir}"
  echo "built ${archive}"
}

build_one linux amd64
build_one linux arm64
build_one darwin amd64
build_one darwin arm64
build_one windows amd64
build_one windows arm64

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${out_dir}" && sha256sum ./* > checksums.txt)
elif command -v shasum >/dev/null 2>&1; then
  (cd "${out_dir}" && shasum -a 256 ./* > checksums.txt)
else
  echo "sha256sum or shasum is required to write checksums.txt" >&2
  exit 1
fi
