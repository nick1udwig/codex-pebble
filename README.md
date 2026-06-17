# Codex Jobs for Pebble

Native Pebble C watch app for monitoring Codex app-server jobs over WebSocket JSON-RPC.

## Scope

- The watch UI is native Pebble C.
- PKJS handles hosted settings, Codex JSON-RPC, and the compact AppMessage bridge to C.
- Browser-like Pebble WebSocket clients connect to a local sidecar because Codex app-server rejects WebSocket handshakes with an `Origin` header.
- There are no `/watch/*` endpoints and no OpenAI credential flow on the watch. The sidecar forwards Codex JSON-RPC messages without translating them.

## Setup

1. Build the hosted config page into `docs/config`:

   ```sh
   npm run build:config:docs
   ```

2. Host `docs/` with GitHub Pages. Published builds default to:

   ```text
   https://nick1udwig.github.io/codex-pebble/config/
   ```
3. Start the sidecar locally:

   ```sh
   npm run dev:sidecar
   ```

   By default this listens for codex-pebble at `ws://127.0.0.1:4501`. On launch it probes Codex app-server in this order, without starting Codex:

   1. Existing Unix-socket app-server at `~/.codex/app-server-control/app-server-control.sock`.
   2. Existing stdio transport attached to the sidecar process's stdin/stdout.

   If neither transport is available, the sidecar exits with an error before accepting watch connections.

   Configure the watch to use the sidecar URL. For the emulator, use:

   ```text
   ws://127.0.0.1:4501
   ```

   For a real phone, bind the sidecar to a Tailnet-reachable or LAN address and use a token:

   ```sh
   npm run dev:sidecar -- --listen <tailnet-ip-or-host>:4501 --token <shared-token>
   ```

   Configure the watch with:

   ```text
   ws://<tailnet-ip-or-host>:4501/?token=<shared-token>
   ```

   To pass a custom Unix socket:

   ```sh
   npm run dev:sidecar -- --unix-socket /path/to/app-server.sock
   ```

   The stdio fallback is only useful when another launcher has already connected the sidecar process's stdin/stdout to `codex app-server --listen stdio://`. The sidecar does not start Codex app-server.

4. Build and install:

   ```sh
   npm run build:watch
   pebble install --emulator emery
   ```

## Testing

The local gates mirror the `tg-pebble` layout:

```sh
npm run test:js
npm run test:config
npm run test:sidecar
npm run test:build
npm run test:pre-release
```

Use `npm run dev:config` to serve the config page at `http://127.0.0.1:4173`.

If a local sidecar is already running, `npm run smoke:app-server -- --ws-url ws://127.0.0.1:4501` performs a read-only JSON-RPC smoke test over the same WebSocket path PKJS uses.

For an emulator smoke test:

```sh
pebble install --emulator emery --logs
```

For a real paired phone dev install:

```sh
npm run deploy:phone
```

## Deployment

- `.github/workflows/pages.yml` builds `docs/config` from `src/config` and deploys GitHub Pages.
- `.github/workflows/public-build.yml` builds a release `.pbw` and uploads it as a workflow artifact.
- `.github/workflows/pre-release.yml` runs JS tests, config-page tests, sidecar tests, and a watch build.

Set GitHub Pages to `GitHub Actions` under repository settings before relying on the Pages workflow.

## Schemas

Generate schemas from the Codex version you run:

```sh
npm run schemas:ts
npm run schemas:json
```

The checked-in `schemas/` directory was generated from the local Codex install and is used by unit tests to catch protocol drift. PKJS currently reads `thread/list`, distills each thread into a compact row, and sends those rows to the native C watch UI with AppMessage.
