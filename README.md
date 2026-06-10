# Codex Jobs for Pebble

Native Pebble C watch app for monitoring Codex app-server jobs over WebSocket JSON-RPC.

## Scope

- The watch UI is native Pebble C.
- PKJS handles hosted settings, Codex JSON-RPC, and the compact AppMessage bridge to C.
- Browser-like Pebble WebSocket clients need the local origin relay because Codex app-server rejects WebSocket handshakes with an `Origin` header.
- There are no `/watch/*` endpoints and no OpenAI credential flow on the watch. The relay only strips the WebSocket `Origin` header; it does not translate Codex JSON-RPC.

## Setup

1. Build the hosted config page into `docs/config`:

   ```sh
   npm run build:config:docs
   ```

2. Host `docs/` with GitHub Pages. Published builds default to:

   ```text
   https://nick1udwig.github.io/codex-pebble/config/
   ```
3. Start Codex app-server locally:

   ```sh
   codex app-server --listen ws://127.0.0.1:4500
   ```

4. In another terminal, start the origin relay:

   ```sh
   npm run dev:relay
   ```

   Configure the watch to use the relay URL, not the upstream app-server URL. For the emulator, use:

   ```text
   ws://127.0.0.1:4501
   ```

   For a real phone, bind the relay to a Tailnet-reachable address and keep it firewalled to trusted devices:

   ```sh
   npm run dev:relay -- --listen ws://<tailnet-ip-or-host>:4501 --upstream ws://127.0.0.1:4500
   ```

5. Build and install:

   ```sh
   npm run build:watch
   pebble install --emulator emery
   ```

## Testing

The local gates mirror the `tg-pebble` layout:

```sh
npm run test:js
npm run test:config
npm run test:build
npm run test:pre-release
```

Use `npm run dev:config` to serve the config page at `http://127.0.0.1:4173`.

If a local Codex app-server and relay are already running, `npm run smoke:app-server -- --ws-url ws://127.0.0.1:4501` performs a read-only JSON-RPC smoke test over the same WebSocket path PKJS uses.

For an emulator smoke test:

```sh
pebble install --emulator emery --logs
```

## Deployment

- `.github/workflows/pages.yml` builds `docs/config` from `src/config` and deploys GitHub Pages.
- `.github/workflows/public-build.yml` builds a release `.pbw` and uploads it as a workflow artifact.
- `.github/workflows/pre-release.yml` runs JS tests, config-page tests, and a watch build.

Set GitHub Pages to `GitHub Actions` under repository settings before relying on the Pages workflow.

## Schemas

Generate schemas from the Codex version you run:

```sh
npm run schemas:ts
npm run schemas:json
```

The checked-in `schemas/` directory was generated from the local Codex install and is used by unit tests to catch protocol drift. PKJS currently reads `thread/list`, distills each thread into a compact row, and sends those rows to the native C watch UI with AppMessage.
