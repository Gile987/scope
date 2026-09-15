# Contributing to Scope

Thanks for your interest in contributing! This guide covers the legal
requirements, how to set up a local environment, the conventions we follow, and
how to get a change reviewed and merged.

## Contributor License Agreement (CLA)

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) for the full statement.

## Reporting security issues

Please **do not** report security vulnerabilities through public GitHub issues. Follow the process in
[`SECURITY.md`](./SECURITY.md) to report them to the Microsoft Security Response Center (MSRC).

## Prerequisites

Scope is a pnpm workspaces monorepo (TypeScript, with a Rust component for the AI gateway).

- **Node.js 22** — the version CI builds and tests against.
- **pnpm 10.29.1** — pinned via the `packageManager` field in [`package.json`](./package.json).
  The easiest way to get the right version is Corepack:

  ```bash
  corepack enable
  ```

- **Docker** — required to run the backing services (MongoDB, Redis, Azurite, Lowkey Vault) and to
  run integration tests.
- **Rust / Cargo** — only needed if you work on the AI gateway (`apps/gateway/`).

## Getting started

```bash
pnpm install                      # Install all workspace dependencies
```

CI installs with `pnpm install --frozen-lockfile`; commit an updated `pnpm-lock.yaml` when you change
dependencies.

## Local development

Start the backing services first, then run the stack or an individual service:

```bash
pnpm docker:up:infra              # Start backing services (MongoDB, Redis, Azurite)
pnpm docker:dev:copilot           # Full stack with the Copilot worker + portal (hot reload)
pnpm docker:dev:all               # All workers + portal + report generator (hot reload)

pnpm dev:api                      # API only (native)
pnpm dev:portal                   # Portal only (native)
pnpm dev:coder-acp-copilot        # A single worker natively (pnpm dev:<service-name>)
pnpm open:portal                  # Open the portal in your browser
```

### Debug the Docker development API

`pnpm docker:dev:portal` starts the API with the Node inspector enabled. To
debug API TypeScript while retaining the Docker stack and hot reload:

1. Run `pnpm docker:dev:portal` and wait for the API to start.
2. Read `API_DEBUG_PORT` from the generated `.env` file (it is worktree-specific).
3. In VS Code, select **Attach API (Docker)** from **Run and Debug**, enter that
   port, and start debugging.
4. Set breakpoints in the workspace source under `apps/api/src`, not in a copied
   or attached snapshot of the file.

The debugger maps the container's `/app` tree to the workspace and reconnects
when `tsx watch` restarts the API after a source change. The inspector is
published on `127.0.0.1` only.

The CLI is the primary interface for CI/CD and power users:

```bash
pnpm cli --help                   # Discover CLI subcommands
```

## Testing

Tests are co-located next to source as `<filename>.test.ts` and run with [Vitest](https://vitest.dev/).

```bash
pnpm test                         # Unit tests
pnpm test:coverage                # Unit tests with a coverage report
pnpm test:integration             # Integration tests (requires a .env file + Docker)
```

## Build, lint, and typecheck

```bash
pnpm build                        # Build every workspace package (pnpm -r build)
pnpm lint                         # Lint/typecheck every package (pnpm -r lint)
```

For the Rust gateway (`apps/gateway/`):

```bash
pnpm build:gateway                # cargo build --release
pnpm test:gateway                 # cargo test
pnpm lint:gateway                 # cargo clippy -- -D warnings
pnpm fmt:gateway                  # cargo fmt --check
```

## Database migrations

Schema changes live in [`packages/db-migrations/`](./packages/db-migrations/) and use
`mongo-migrate-ts` (TypeScript files with `up()` / `down()`):

```bash
pnpm migrate:up                   # Apply pending migrations
pnpm migrate:down                 # Roll back the last migration
pnpm migrate:status               # Show migration status
```

MongoDB is CosmosDB-compatible — avoid MongoDB features that CosmosDB's MongoDB API does not support.

## Coding conventions

- **TypeScript**: strict mode, ES2022, NodeNext modules.
- **License headers**: every first-party source file must start with the Microsoft MIT header. Run
  `pnpm headers` to add it; CI enforces it via `pnpm headers:check`.
- **Tests**: co-locate them next to the source as `<filename>.test.ts` (Vitest).
- **CLI ↔ Portal parity**: every feature available in the Portal must also be available in the CLI —
  the CLI must never lag behind the Portal.
- **Portal + Storybook**: when you add or change a portal component, update its Storybook stories.
- **Rust**: for any change under `apps/gateway/`, follow the `rust-best-practices` skill
  (`.agents/skills/rust-best-practices/SKILL.md`).
- **Databases**: keep MongoDB usage CosmosDB-compatible (see migrations above).
- **Documentation is not optional**: if you add or change a component, API, data model, pattern, or
  deployment behavior, update the relevant doc in [`docs/`](./docs/) (or add one and link it from the
  README) as the last step before opening your PR.

## Submitting a pull request

1. Fork the repository and create a topic branch from `main`.
2. Make your change, keeping it focused and adding/adjusting co-located tests.
3. Run `pnpm lint` and `pnpm test` locally (plus `pnpm test:integration` when your change touches a
   worker or backing service) and make sure they pass.
4. Update any documentation affected by your change.
5. Write clear, descriptive commit messages and PR descriptions; link the issue(s) your PR addresses.
6. Open the PR and complete the CLA check if the bot asks you to. Address review feedback and keep the
   branch up to date with `main`.

## Project structure and where to start

- Start with the [architecture overview](./docs/architecture/overview.md) and the
  [app design](./docs/architecture/app-design.md) docs for the big picture.
- The [README](./README.md) introduces the platform, provides a local quick start, and links the full documentation index.
- Planned work (e.g. test variations and experiment-level analysis) is flagged as *Upcoming* in the
  README's Key Features — good starting points if you're looking for larger areas to help with.
