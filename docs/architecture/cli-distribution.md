# CLI Distribution

How the Scope CLI is bundled, distributed, and updated as a standalone tool.

## Overview

The CLI is bundled into a single `.mjs` file using [esbuild](https://esbuild.github.io/), distributed via GitHub Releases on the `scope-doc` repo, and installed using the `gh` CLI. This allows users to run the CLI without checking out the monorepo.

```mermaid
flowchart LR
    A[scope-core<br/>apps/cli/] -->|publish-cli.yml| B[GitHub Actions]
    B -->|gh release create| C[scope-doc releases<br/>scope.mjs + install.sh]
    C -->|gh release download| D[User workstation<br/>~/.local/bin/scope]
```

## Building

The build script lives at `apps/cli/build.ts` (TypeScript, run via `tsx`):

```bash
pnpm build:cli        # from repo root
pnpm build            # from apps/cli/
```

This produces `apps/cli/dist/scope.mjs` (~1MB minified).

### Build-time injection

| Define | Source | Purpose |
|--------|--------|---------|
| `process.env.SCOPE_CLI_VERSION` | `apps/cli/package.json` version | Reported by `--version` |
| `process.env.SCOPE_DEFAULT_API_URL` | `SCOPE_DEFAULT_API_URL` env var or `http://scope.eastus2.cloudapp.azure.com` | Default API URL in bundled builds |

In dev mode (`pnpm cli` via tsx), these defines are not applied — the CLI falls back to `http://localhost:3100`.

### esbuild plugins

| Plugin | Purpose |
|--------|---------|
| `strip-shebang` | Removes the source shebang so esbuild's banner shebang is the only one |
| `shim-react-devtools` | Stubs out `react-devtools-core` (optional Ink peer dep, not installed) |

### Key design decisions

- **ESM format** with a `createRequire` polyfill banner (CJS won't work due to Ink's top-level await)
- **All dependencies bundled** — no `node_modules` needed at runtime
- **Node.js >= 20 required** at runtime

## Versioning

The **source of truth** for the CLI version is the git tag on `scope-core` (e.g. `v0.2.0`). The `apps/cli/package.json` version is `0.0.0-dev` — a placeholder that CI bumps transiently via `pnpm version` during the publish workflow. It is never committed back to `main`.

- Local builds produce `0.0.0-dev` — clearly indicating a dev build.
- Dev mode (`pnpm cli`) reports `0.1.0-dev`.
- Only CI-built releases carry a real version number.

## Publishing

The publish workflow (`.github/workflows/publish-cli.yml`) is triggered manually:

1. Select bump type: `patch` | `minor` | `major` (default: minor)
2. Workflow bumps `apps/cli/package.json` via `pnpm version`
3. Builds the bundle with prod API URL (`vars.SCOPE_API_URL`)
4. Creates a git tag `v<version>` on scope-core
5. Creates a GitHub Release on `scope-doc` with `scope.mjs` + `install.sh`

### Required secrets/variables

| Name | Type | Purpose |
|------|------|---------|
| `SCOPE_DOC_TOKEN` | Secret | PAT with `contents:write` on scope-doc repo |
| `SCOPE_API_URL` | Variable | Production API URL injected at build time |

## Installation

Users install via the `gh` CLI (required since the repo is EMU-protected):

```bash
gh release download --repo growth-ecosystems/scope-doc --pattern install.sh -O - | bash
```

The installer (`apps/cli/install.sh`):
1. Downloads `scope.mjs` from the latest release
2. Places it at `~/.local/bin/scope`
3. Makes it executable

Prerequisites: Node.js >= 20, `gh` CLI authenticated.

## Update check

After each command, the CLI performs a non-blocking check for newer versions:

- Queries the GitHub Releases API on `scope-doc` (3s timeout)
- Compares the current embedded version against the latest release tag
- If newer, prints a one-line notice with the upgrade command
- Suppressed by `SCOPE_NO_UPDATE_CHECK=1`
- Requires `GH_TOKEN` or `GITHUB_TOKEN` for private repo access (silently skips without it)

Source: `apps/cli/src/utils/update-check.ts`

## Local development vs bundled

| Aspect | Dev (`pnpm cli`) | Bundled (`scope`) |
|--------|-------------------|-------------------|
| Runner | tsx (TypeScript direct) | Node.js (single .mjs) |
| API default | `http://localhost:3100` | `http://scope.eastus2.cloudapp.azure.com` |
| Version | `0.1.0-dev` | Actual semver from CI bump |
| Command name | `pnpm cli` | `scope` |
| Update check | Disabled | Enabled |
