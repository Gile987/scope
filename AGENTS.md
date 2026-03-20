# Scope MT

Scope MT is a platform for benchmarking AI coding agents. It orchestrates multiple coding agents (GitHub Copilot, Claude Code, VS Code Web), sends them standardized tasks through configurable scenarios and personas, evaluates results using a criteria DAG with the Judge service, and tracks everything with real-time logging.

Built as a **pnpm workspaces monorepo** with TypeScript. For full system context, see [docs/architecture/overview.md](docs/architecture/overview.md).

## api

The Express.js REST server that orchestrates runs, streams logs via SSE, manages criteria CRUD, and routes tasks to workers through Azure Storage Queues.

### Instructions

You are an expert on the Scope MT API server at `apps/api/`.

**Codebase context:**
- Express.js REST API with SSE log streaming, run management, and criteria CRUD
- Connects to MongoDB (CosmosDB-compatible), Redis, Azure Storage Queues, and Blob Storage
- The `packages/shared/` package provides types, DB models, queue/blob/redis clients, and config loaders — always import from there, never duplicate
- API design and data models are documented in [docs/architecture/app-design.md](docs/architecture/app-design.md)
- Environment variables are documented in [ENV_VARIABLES.md](ENV_VARIABLES.md)
- The SSE + Change Streams pattern is described in [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md)

**Conventions:**
- TypeScript with strict mode, ES2022 target, NodeNext module resolution
- Co-locate tests next to source files as `<filename>.test.ts` using Vitest
- Run tests with `pnpm test` from the repo root
- Use `pnpm docker:up:infra` to start backing services (MongoDB, Redis, Azurite) locally
- Always run `cd <repo-root> && pnpm dev:api` to start the API in dev mode

## worker

Expert on building and modifying coding agent workers — the adapters that connect different AI agents (Copilot, Claude Code, VS Code Web) to the Scope MT benchmarking pipeline.

### Instructions

You are an expert on Scope MT's coding agent workers at `apps/workers/`.

**Codebase context:**
- Each worker implements the same queue-processor interface but adapts a different coding agent
- `coder-acp-copilot` — GitHub Copilot via ACP SDK v0.14.1
- `coder-acp-claude-code` — Claude Code via ACP SDK v0.13.1
- `report-generator` — Post-processing report generation using Copilot SDK
- Workers consume tasks from Azure Storage Queues and write results to MongoDB and Blob Storage
- The VS Code Web worker has a dedicated architecture doc: [docs/architecture/vscode-web-worker.md](docs/architecture/vscode-web-worker.md)
- Skills integration is documented in [docs/architecture/skills.md](docs/architecture/skills.md)
- Version checkers in `apps/version-checkers/` poll for new agent releases
- Model scanners in `apps/model-scanners/` detect available model features

**Conventions:**
- Workers share types and utilities via `packages/shared/`
- Each worker has its own `Dockerfile` and docker-compose profile
- Queue names follow the pattern `queue-<worker-name>`
- Use `packages/version-checking/` for version check utilities and `packages/model-scanning/` for model feature detection
- Test with `pnpm test` and run locally via `pnpm dev:<worker-name>` or `pnpm docker:dev:copilot`

## judge

Expert on the evaluation engine that scores coding agent output against a criteria DAG (directed acyclic graph).

### Instructions

You are an expert on the Scope MT Judge at `apps/judge/`.

**Codebase context:**
- The judge evaluates agent output using criteria defined as a DAG — criteria can have parent-child dependencies
- Uses the GitHub Copilot SDK for LLM-based evaluation
- Strategies: `bundled` (all criteria in one session) or `independent` (topological order, skips descendants of failures)
- The CriteriaProvider abstraction supports filesystem and REST API backends: [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md)
- Criteria YAML definitions live in `config/criteria/`
- Judge environment variables (strategy, parallelism, feedback) are in [ENV_VARIABLES.md](ENV_VARIABLES.md)

**Conventions:**
- Criteria are YAML files in `config/criteria/` with behavior descriptions and optional parent references
- The judge is an Express service that receives evaluation requests from the API
- Import types and shared utilities from `packages/shared/`
- Co-locate tests as `<filename>.test.ts`

## portal

Frontend development expert for the React web UI — the dashboard for run management, insights visualization, and criteria graph editing.

### Instructions

You are an expert on the Scope MT Portal at `apps/portal/`.

**Codebase context:**
- React 19 with Vite, TypeScript, Tailwind CSS
- Component library: Radix UI (shadcn/ui pattern via `components.json`)
- Data fetching: TanStack Query (React Query)
- Criteria DAG visualization: XYFlow (React Flow)
- Communicates with the API via REST and SSE for real-time updates
- The real-time data flow pattern is described in [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md)

**Conventions:**
- Follow shadcn/ui conventions for new components — use `components.json` for component generation
- Use TanStack Query hooks for all API communication
- Tailwind for styling — no CSS modules or styled-components
- Run with `pnpm dev:portal` or as part of `pnpm docker:dev:copilot`
- Open in browser with `pnpm open:portal`

## cli

Expert on the command-line interface for submitting runs, streaming logs, and managing the benchmarking pipeline from the terminal.

### Instructions

You are an expert on the Scope MT CLI at `apps/cli/`.

**Codebase context:**
- Built with Commander.js for command parsing and Ink (React for terminals) for interactive UI
- Used for scripting, CI/CD automation, and developer workflows
- Submits runs, streams logs, manages criteria, and interacts with the API
- Always print help first to discover subcommands: `pnpm cli --help`

**Conventions:**
- Run with `pnpm cli <command>` from the repo root
- Import types and shared utilities from `packages/shared/`
- Co-locate tests as `<filename>.test.ts`

## config

Expert on managing benchmark configurations — scenarios, personas, criteria, traits, and prompt features defined as YAML.

### Instructions

You are an expert on Scope MT's configuration system in `config/`.

**Codebase context:**
- `config/traits.yaml` — Evaluation trait dimensions (personality, experience, verbosity, type)
- `config/personas/` — Pre-built reviewer personas combining traits (e.g. `demanding-senior.yaml`, `vibe-coder.yaml`)
- `config/scenarios/` — Task definitions that coding agents must implement (e.g. `hello-world-express.yaml`, `react-snake-game-v2.yaml`)
- `config/criteria/` — YAML-defined evaluation criteria forming a DAG, consumed by the judge
- `config/prompt-features/` — Feature flags tracking what capabilities agents request
- The criteria system is documented in [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md) and [docs/architecture/app-design.md](docs/architecture/app-design.md)

**Conventions:**
- All config is YAML — follow the existing schema patterns in each folder
- Criteria support parent references for DAG dependencies
- Scenarios define the task prompt, expected outcomes, and which criteria apply
- Personas combine traits into a reviewer personality that shapes judge behavior

## deploy

Expert on Kubernetes deployment manifests — Kustomize bases, environment overlays, and FluxCD image automation.

### Instructions

You are an expert on Scope MT's deployment manifests in `deploy/`.

**Codebase context:**
- `deploy/base/` — Base Kubernetes resources for all services and workers
- `deploy/base/workers/` — Worker-specific Deployments, KEDA ScaledObjects, version registration Jobs
- `deploy/overlays/integration/` — Int environment overlay (image tags auto-updated by FluxCD)
- `deploy/overlays/prod/` — Prod environment overlay (updated via promotion workflow)
- `deploy/overlays/preview/` — Preview environment for PR-based deployments
- `deploy/image-automation/` — FluxCD ImageUpdateAutomation and ImagePolicy resources
- `deploy/pr-envs/` — Preview environment per PR
- The deployment model is documented in [docs/architecture/deployment.md](docs/architecture/deployment.md)
- The CI/CD workflows are in `.github/workflows/` — `ci.yml` for builds, `promote.yml` for int→prod promotion

**Conventions:**
- All changes must go through manifests, never `kubectl apply` directly
- Use Kustomize overlays to differentiate per environment
- Image tags follow `<timestamp>-<sha>` format
- KEDA ScaledObjects manage worker autoscaling based on queue depth
- FluxCD image automation watches int ACR and auto-updates `overlays/integration/images.yaml`

## db

Expert on MongoDB database migrations using the lightweight migration framework.

### Instructions

You are an expert on the Scope MT database migration system in `packages/db-migrations/`.

**Codebase context:**
- Built on `mongo-migrate-ts` — migrations are TypeScript files with `up()` and `down()` methods
- Migration framework is documented in [docs/architecture/db-migrations.md](docs/architecture/db-migrations.md)
- MongoDB is CosmosDB-compatible — avoid features not supported by CosmosDB's MongoDB API

**Conventions:**
- Run migrations: `pnpm migrate:up`, `pnpm migrate:down`, `pnpm migrate:status`
- Create new migrations in the `packages/db-migrations/` migrations directory
- Each migration must be idempotent and reversible
- Test migrations against local MongoDB via `pnpm docker:up:infra`

## shared

Expert on the shared package — the monorepo foundation providing types, DB models, queue/blob/redis clients, config loaders, and utilities used by all apps.

### Instructions

You are an expert on the `packages/shared/` package.

**Codebase context:**
- Exports types (runs, iterations, criteria, scenarios, personas), Mongoose models, and service clients
- Named exports include `criteria-store`, `criteria-provider`, `queue-client`, `blob-client`, `redis-client`, `config-loader`
- The package architecture and dependency graph are documented in [docs/architecture/app-design.md](docs/architecture/app-design.md)
- The CriteriaProvider abstraction is documented in [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md)

**Conventions:**
- All apps and workers depend on `shared` — changes here affect the entire monorepo
- Export public API through the package's main entry point and named exports
- Co-locate tests as `<filename>.test.ts`
- Be careful with breaking changes — run `pnpm test` from the repo root to verify all consumers

## token-manager

Expert on the centralized token management service — storage, validation, and round-robin distribution of API tokens and credentials.

### Instructions

You are an expert on the Token Manager at `apps/token-manager/`.

**Codebase context:**
- Express service for centralized token storage, validation, and round-robin distribution
- Integrates with Azure Key Vault (Lowkey Vault locally) for secure secret storage
- Serves tokens to workers and other services
- Documented in [docs/architecture/token-manager.md](docs/architecture/token-manager.md)

**Conventions:**
- Uses `packages/github-auth/` for GitHub OAuth/device-code auth utilities
- Test locally with Lowkey Vault via `pnpm docker:up:infra`
- Co-locate tests as `<filename>.test.ts`
