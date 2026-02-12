# Application Design

> **Status:** Seed document — expand as the application evolves.

This document describes the internal design of the Scope MT application layer (`scope-mt-app/`).

## Package Architecture

Scope MT uses a **pnpm workspaces** monorepo. Packages share types and utilities via the `shared` package.

```mermaid
flowchart LR
    cli --> api
    portal --> api
    api --> shared
    judge --> shared
    workers --> shared
    workers --> judge
    cli --> shared
```

| Package | Responsibility |
|---------|---------------|
| `api` | REST API (Express), SSE log streaming, run management, criteria CRUD |
| `cli` | Command-line interface for submitting tasks, streaming logs, managing runs |
| `portal` | Vue.js web UI for run management, insights, criteria graph editing |
| `judge` | Evaluation engine — executes criteria against agent output |
| `shared` | Types, database models, queue/blob/redis clients, config loaders |
| `workers/*` | Coding agent adapters — each implements the same interface for a different agent |

## Data Model

Runs are the central entity:

```mermaid
erDiagram
    RUN ||--o{ ITERATION : has
    RUN ||--o{ LOG_EVENT : produces
    RUN }o--|| SCENARIO : uses
    RUN }o--|| PERSONA : uses
    RUN }o--|| WORKER_TYPE : targets
    ITERATION ||--o{ CRITERION_RESULT : evaluated_by
    CRITERION ||--o{ CRITERION_RESULT : produces
    CRITERION }o--o{ CRITERION : depends_on
```

- **Run** — A single benchmark execution: one scenario + one persona + one worker
- **Iteration** — A coding agent turn within a run (agent may iterate multiple times)
- **Criterion** — An evaluation check (e.g., "has a working Express server"). Criteria form a DAG (directed acyclic graph) with dependencies.
- **CriterionResult** — Pass/fail result of evaluating a criterion against a specific iteration

## Judge Pipeline

The judge evaluates coding agent output against criteria. Two strategies are supported:

| Strategy | Behavior |
|----------|----------|
| `bundled` | All criteria evaluated in one judge session (faster, less granular) |
| `independent` | Criteria evaluated separately in topological order following the DAG; descendants of failed criteria are skipped (slower, more accurate) |

```mermaid
flowchart TD
    A[Agent completes iteration] --> B[Load criteria DAG]
    B --> C{Strategy?}
    C -->|bundled| D[Single judge session: all criteria]
    C -->|independent| E[Topological sort]
    E --> F[Evaluate root criteria first]
    F --> G{Passed?}
    G -->|yes| H[Evaluate dependents]
    G -->|no| I[Skip descendant criteria]
    D --> J[Store results]
    H --> J
    I --> J
```

## Queue Pattern

Each worker type has a dedicated Azure Storage Queue. The API enqueues messages to the correct queue based on the target worker. KEDA monitors queue depth and scales workers from 0 to N.

```
queue-coder-acp-claude-code  →  coder-acp-claude-code pods (0→N)
queue-coder-acp-copilot      →  coder-acp-copilot pods (0→N)
```

## Real-Time Log Streaming

Workers publish log events to Redis Pub/Sub channels keyed by run ID. The API subscribes and relays them as Server-Sent Events (SSE) to CLI and Portal clients.

## Criteria System

Criteria are reusable evaluation rules stored in the database and optionally defined in `config/criteria/*.yaml`. They support:

- **DAG dependencies** — criterion A can depend on criterion B (B must pass before A is evaluated)
- **AI-generated prompts** — natural language behavior descriptions can be converted to evaluation prompts via LLM
- **Traits** — reusable labels for filtering and composition (e.g., `has_azure`, `has_node`)

See [`ENV_VARIABLES.md`](../../scope-mt-app/ENV_VARIABLES.md) for related configuration options.
