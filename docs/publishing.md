# Publishing Notes

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

## GitHub Actions

- `.github/workflows/pages.yml` deploys `docs/` through GitHub Pages.
- `.github/workflows/public-build.yml` uploads `build/codex-pebble-release.pbw`, `build/appinfo.json`, and `docs/config`.
- `.github/workflows/pre-release.yml` runs the local pre-release gate on pushes and pull requests.

## GitHub Pages Setup

1. Push `master` with the workflow files.
2. Open `Settings -> Pages` in GitHub.
3. Set `Build and deployment` to `GitHub Actions`.
4. Run the `Deploy Pages` workflow.
5. Verify the config page URL loads.
