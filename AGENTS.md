# Scope

Scope is a platform for benchmarking AI coding agents. It orchestrates multiple coding agents (GitHub Copilot, Claude Code, VS Code Web), sends them standardized tasks through configurable scenarios and personas, evaluates results using a criteria DAG with the Judge service, and tracks everything with real-time logging.

For the full system architecture, see [docs/architecture/overview.md](docs/architecture/overview.md).

## Repository Structure

pnpm workspaces monorepo. TypeScript, strict mode, ES2022, NodeNext modules.

```
apps/
  api/                          # REST API — run orchestration, SSE log streaming, criteria CRUD
  cli/                          # CLI — submit runs, stream logs, manage criteria
  judge/                        # Evaluation engine — scores agent output against criteria DAG
  portal/                       # Web UI — run management, insights, criteria graph editor
  token-manager/                # Token storage, validation, round-robin distribution
  workers/
    coder-acp-copilot/          # GitHub Copilot worker (ACP SDK)
    coder-acp-claude-code/      # Claude Code worker (ACP SDK)
    report-generator/           # Post-run report generation
  model-scanners/               # Feature detection for Copilot and Anthropic models
  version-checkers/             # Poll for new agent/tool releases
  key-updaters/                 # GitHub auth cookie management for VS Code Web
packages/
  shared/                       # Monorepo foundation — types, DB models, queue/blob/redis clients
  db-migrations/                # MongoDB migration framework (mongo-migrate-ts)
  github-auth/                  # GitHub OAuth/device-code auth utilities
  model-scanning/               # Shared model scanning logic
  version-checking/             # Version comparison utilities
config/                         # Benchmark definitions (YAML)
deploy/                         # Kubernetes manifests (Kustomize + FluxCD)
```

For package architecture and data models, see [docs/architecture/app-design.md](docs/architecture/app-design.md).

## Key Components

### API (`apps/api/`)

Express.js REST server. Orchestrates runs, streams logs via SSE, manages criteria CRUD, routes tasks to workers through Azure Storage Queues. Connects to MongoDB (CosmosDB-compatible), Redis, Azure Storage Queues, and Blob Storage.

- Data models and API design: [docs/architecture/app-design.md](docs/architecture/app-design.md)
- SSE + Change Streams pattern: [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md)
- Environment variables: [ENV_VARIABLES.md](ENV_VARIABLES.md)

### Workers (`apps/workers/`)

Each worker implements the same queue-processor interface but adapts a different coding agent:

| Worker | Agent | Protocol |
|--------|-------|----------|
| `coder-acp-copilot` | GitHub Copilot | ACP SDK v0.14.1 |
| `coder-acp-claude-code` | Claude Code | ACP SDK v0.13.1 |
| `report-generator` | — | Copilot SDK |

Workers consume tasks from Azure Storage Queues (named `queue-<worker-name>`) and write results to MongoDB and Blob Storage. Each has its own Dockerfile and docker-compose profile.

- VS Code Web worker architecture: [docs/architecture/vscode-web-worker.md](docs/architecture/vscode-web-worker.md)
- Skills integration: [docs/architecture/skills.md](docs/architecture/skills.md)

### Judge (`apps/judge/`)

Evaluation engine that scores agent output against a criteria DAG (directed acyclic graph). Uses the GitHub Copilot SDK for LLM-based evaluation. Two strategies: `bundled` (all criteria in one session) or `independent` (topological order, skips descendants of failures).

- CriteriaProvider abstraction: [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md)
- Judge configuration variables: [ENV_VARIABLES.md](ENV_VARIABLES.md)

### Portal (`apps/portal/`)

React 19 web UI with Vite, Tailwind CSS, Radix UI (shadcn/ui), TanStack Query, and XYFlow for criteria DAG visualization. Communicates with the API via REST and SSE.

- Real-time data flow: [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md)

> **Storybook**: When adding or modifying portal components, update the corresponding Storybook stories. Use the `storybook` skill for guidance.

### CLI (`apps/cli/`)

Command-line interface built with Commander.js and Ink (React for terminals). Used for submitting runs, streaming logs, managing criteria, and CI/CD automation. Run `pnpm cli --help` to discover subcommands.

> **CLI ↔ Portal parity**: Every feature available in the Portal must also be available in the CLI. The CLI is the primary interface for CI/CD and power users — it must never lag behind the Portal in capabilities.

- Distribution and standalone installation: [docs/architecture/cli-distribution.md](docs/architecture/cli-distribution.md)

### Token Manager (`apps/token-manager/`)

Express service for centralized token storage, validation, and round-robin distribution. Integrates with Azure Key Vault (Lowkey Vault locally). Uses `packages/github-auth/` for GitHub OAuth/device-code auth.

- Architecture: [docs/architecture/token-manager.md](docs/architecture/token-manager.md)

### Shared Package (`packages/shared/`)

Monorepo foundation. Exports types (runs, iterations, criteria, scenarios, personas), Mongoose models, and service clients (queue, blob, redis, config loader, criteria-store, criteria-provider). All apps and workers depend on it — breaking changes here affect everything.

- Package dependency graph: [docs/architecture/app-design.md](docs/architecture/app-design.md)
- CriteriaProvider abstraction: [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md)

## Configuration (`config/`)

Personas, scenarios (tasks), criteria, and prompt features are stored in **MongoDB** (source of truth). They can be exported/imported as YAML for portability and version control. The `config/` folder contains YAML examples of these data types.

- `traits.yaml` — Evaluation trait dimensions (personality, experience, verbosity, type)
- `personas/` — Reviewer personas combining traits (e.g. `demanding-senior.yaml`, `vibe-coder.yaml`)
- `scenarios/` — Task definitions agents must implement (e.g. `hello-world-express.yaml`, `react-snake-game-v2.yaml`)
- `criteria/` — Evaluation criteria forming a DAG with parent-child dependencies, consumed by the judge
- `prompt-features/` — Feature flags tracking what capabilities agents request

## Deployment (`deploy/`)

Kubernetes manifests using Kustomize overlays and FluxCD image automation. All infrastructure changes go through manifests — never `kubectl apply` directly.

```
deploy/base/                    # Base K8s resources (services + workers)
deploy/base/workers/            # Worker Deployments, KEDA ScaledObjects, registration Jobs
deploy/overlays/integration/    # Int environment (image tags auto-updated by FluxCD)
deploy/overlays/prod/           # Prod environment (updated via promotion workflow)
deploy/overlays/preview/        # Preview environment for PR deployments
deploy/image-automation/        # FluxCD ImageUpdateAutomation + ImagePolicy
```

Image tags follow `<timestamp>-<sha>` format. KEDA ScaledObjects autoscale workers based on queue depth. CI in `.github/workflows/ci.yml`, promotion via `.github/workflows/promote.yml`.

- Deployment model: [docs/architecture/deployment.md](docs/architecture/deployment.md)

## Database Migrations (`packages/db-migrations/`)

Built on `mongo-migrate-ts`. Migrations are TypeScript files with `up()` and `down()` methods. MongoDB is CosmosDB-compatible — avoid features not supported by CosmosDB's MongoDB API.

- Run: `pnpm migrate:up`, `pnpm migrate:down`, `pnpm migrate:status`
- Framework docs: [docs/architecture/db-migrations.md](docs/architecture/db-migrations.md)

## Development

```bash
pnpm docker:up:infra              # Start backing services (MongoDB, Redis, Azurite, Lowkey Vault)
pnpm docker:dev:copilot           # Full stack with Copilot worker + portal (hot reload)
pnpm docker:dev:all               # All workers + portal + report generator (hot reload)
pnpm dev:api                      # API only (native)
pnpm dev:portal                   # Portal only (native)
pnpm dev:<worker-name>            # Individual worker (native)
pnpm open:portal                  # Open portal in browser
```

### Shared Dev Infrastructure (CosmosDB)

For testing against real Azure CosmosDB (e.g. index behavior), a shared dev instance can be provisioned. Each worktree gets its own isolated database. See [docs/shared-dev-infra.md](docs/shared-dev-infra.md) for setup and usage.

## Rust Components

When making changes to any Rust component (e.g. the AI gateway in `apps/gateway/`), follow the `rust-best-practices` skill. This skill is available at `.agents/skills/rust-best-practices/SKILL.md` and covers idiomatic Rust, ownership patterns, error handling with `Result`, and performance guidelines.

## Testing

Co-locate tests next to source as `<filename>.test.ts`. Framework: Vitest.

```bash
pnpm test                         # Unit tests
pnpm test:coverage                # With coverage report
pnpm test:integration             # Integration tests (requires .env + Docker)
```

## Documentation Workflow

**Before starting any task**, read the docs relevant to the components you will be working on (see the table below). Understanding the existing design, data models, and patterns prevents regressions and duplicated work.

**Before completing any task**, update the relevant docs to reflect your changes. This is the last step before calling the work done. If you added a new component, added or changed an API, modified data models, introduced a new pattern, or changed deployment behavior, the corresponding doc must be updated (or a new one created and linked here). Documentation is not optional — outdated docs are worse than no docs.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/architecture/overview.md](docs/architecture/overview.md) | System architecture, component interactions, data flow |
| [docs/architecture/app-design.md](docs/architecture/app-design.md) | Data models, API design, package dependency graph |
| [docs/architecture/vscode-web-worker.md](docs/architecture/vscode-web-worker.md) | XState chat machine, GitHub auth flow, ARIA snapshots |
| [docs/architecture/token-manager.md](docs/architecture/token-manager.md) | Token storage, validation, round-robin distribution |
| [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md) | CriteriaProvider abstraction, filesystem vs REST backends |
| [docs/architecture/skills.md](docs/architecture/skills.md) | Agent Skills spec, registration, resolution, delivery |
| [docs/architecture/db-migrations.md](docs/architecture/db-migrations.md) | MongoDB migration framework |
| [docs/architecture/deployment.md](docs/architecture/deployment.md) | Single-branch deployment, int→prod promotion |
| [docs/architecture/cli-distribution.md](docs/architecture/cli-distribution.md) | CLI bundling, publishing, installation, update check |
| [docs/architecture/retry.md](docs/architecture/retry.md) | Retry utilities: `withRetry` function and `@Retry` decorator |
| [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md) | SSE + Change Streams, Redis pub/sub, polling patterns |
| [docs/research/delta-storage.md](docs/research/delta-storage.md) | Space-efficient storage of iteration snapshots |
| [docs/shared-dev-infra.md](docs/shared-dev-infra.md) | Shared dev infrastructure (CosmosDB) setup and worktree isolation |
| [ENV_VARIABLES.md](ENV_VARIABLES.md) | Environment variable reference |
