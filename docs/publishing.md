# Publishing Notes

## App Icon

The source icon is [`assets/codex-jobs-icon.svg`](../assets/codex-jobs-icon.svg), imported from `~/git/iconography/icons/50px_Terminal.svg`.

Use [`assets/codex-jobs-icon.png`](../assets/codex-jobs-icon.png) as the app store submission icon. The watch app menu icon is generated as [`resources/codex-jobs-menu-icon.png`](../resources/codex-jobs-menu-icon.png) and referenced from `package.json`.

## Public Config Page

The Pebble config page for published builds is served from:

```text
https://nick1udwig.github.io/codex-pebble/config/
```

Generate the hosted static files from the source config page with:

```sh
npm run build:config:docs
```

That copies `src/config/` to `docs/config/` for GitHub Pages hosting.

## Public Build

Build a release package with:

```sh
npm run build:watch:release
```

The release script minifies `pebble-js-app.js`, removes the source map from the `.pbw`, and writes:

```text
build/codex-pebble-release.pbw
```

Tracked Pebble publication metadata lives in [`appinfo.json`](../appinfo.json).
It is generated from `package.json` with:

```sh
npm run sync:appinfo
```

The `npm version` lifecycle runs that sync automatically so release version
bumps keep `versionLabel` aligned with `package.json`.

## Sidecar Binaries

Build release archives for the Go sidecar with:

```sh
npm run build:sidecar:release -- v0.1.0
```

That writes Linux, macOS, and Windows archives plus `checksums.txt` to:

```text
build/sidecar-release/
```

## Codex Schemas

Refresh generated app-server contracts when updating the Codex version used for
the watch app:

```sh
npm run schemas:json
npm run schemas:ts
```

The JS tests assert that the watch client's RPC allowlist matches those
generated contracts.

## GitHub Actions

- `.github/workflows/pages.yml` deploys `docs/` through GitHub Pages.
- `.github/workflows/public-build.yml` uploads `build/codex-pebble-release.pbw`, `build/appinfo.json`, and `docs/config`.
- `.github/workflows/pre-release.yml` runs the local pre-release gate on pushes and pull requests.
- `.github/workflows/release.yml` manually bumps `package.json`, commits and tags `vX.Y.Z`, then publishes a GitHub release with the public `.pbw` and sidecar binaries.

## GitHub Pages Setup

1. Push `master` with the workflow files.
2. Open `Settings -> Pages` in GitHub.
3. Set `Build and deployment` to `GitHub Actions`.
4. Run the `Deploy Pages` workflow.
5. Verify the config page URL loads.
