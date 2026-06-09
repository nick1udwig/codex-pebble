# Codex Jobs for Pebble

RePebble Alloy watch app for monitoring active Codex app-server jobs over the unmodified WebSocket JSON-RPC protocol.

## Scope

- Watch-side job data uses `ws://<tailscale-host>:<port>` and Codex app-server JSON-RPC.
- PKJS is only used for the Moddable network proxy and local configuration relay.
- There are no `/watch/*` endpoints, no custom bridge server, and no OpenAI credential flow on the watch.

## Setup

1. Install the proxy package if your Pebble toolchain has not already installed dependencies:

   ```sh
   pebble package install @moddable/pebbleproxy
   ```

2. Build the hosted config page into `docs/config`:

   ```sh
   npm run build:config:docs
   ```

3. Host `docs/` with GitHub Pages. Published builds default to:

   ```text
   https://nick1udwig.github.io/codex-pebble/config/
   ```
4. Start Codex app-server on a Tailnet-reachable address:

   ```sh
   codex app-server --listen ws://<tailscale-ip-or-host>:4500
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
