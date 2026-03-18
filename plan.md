# Plan: Agent version registry + self-registration (#288)

**Branch:** `feat/agent-version-registry`  
**Base:** `main`  
**Depends on:** #287 (version-aware image tags — provides `versions.env` + `GIT_COMMIT` in Dockerfiles)

## Overview

Make agent versions first-class: workers register on startup, portal shows deployed versions, runs track which version processed them.

## Implementation Steps

### Step 1 — Data model types

**Files:** `packages/shared/src/types/types.ts`

- Add `AgentVersion` interface:
  ```typescript
  interface AgentVersion {
    agentVersion: string;                  // "copilot-0.0.415" (PK — one entry per software version)
    workerVersion: string;                 // "copilot-0.0.415-20260318T163740Z-44d16d6" (latest deployed build)
    components: Record<string, string>;    // { COPILOT_CLI_VERSION: "0.0.415" }
    gitCommit: string;
    buildTime: string;                     // ISO 8601 build timestamp
    imageTag: string;
    queueName: string;
    status: "active" | "retired";
    createdAt: Date;
  }
  ```
- Add `versions?: AgentVersion[]` to `CodingAgentDocument`
- Update `agentVersion` semantic on `RequestDocument`: now derived from `versions.env` component prefix (e.g. `copilot-0.0.415`, `vscode-1.111.0-copilot-0.39.0`). FK → `AgentVersion.agentVersion`
- Add `workerVersion?: string` to `RequestDocument` — records the exact build that processed the run (e.g. `copilot-0.0.415-20260318T163740Z-44d16d6`)

**Tests:** Unit tests for type validation/guards if any utility functions are added.

### Step 2 — API endpoints for agent versions

**Files:** `apps/api/src/index.ts`

Add three new endpoints after existing agent routes:

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/v1/agents/:id/versions` | List versions, optional `?status=active` filter |
| `POST` | `/api/v1/agents/:id/versions` | Register/upsert version by `agentVersion` (PK). If exists, update `workerVersion`/`gitCommit`/`buildTime`; otherwise `$push` |
| `PATCH` | `/api/v1/agents/:id/versions/:agentVersion` | Update status (e.g. retire) |

- `POST` upserts by `agentVersion`: same software version with a new build updates the existing entry (new `workerVersion`, `gitCommit`, `buildTime`)
- Input validation for required fields (`agentVersion`, `workerVersion`, `components`, `gitCommit`, `buildTime`, `imageTag`, `queueName`)

**Tests:** API endpoint tests (integration-style using supertest or similar existing pattern).

### Step 3 — Worker self-registration on startup

**Files:**
- `deploy/base/workers/register-version-copilot.yaml` — K8s Job using worker image
- `deploy/base/workers/register-version-claude-code.yaml` — K8s Job using worker image
- `deploy/base/workers/register-version-vscode-web.yaml` — K8s Job using worker image
- `deploy/base/workers/kustomization.yaml` — add new jobs

Workers scale to zero via KEDA, so startup self-registration would never fire. Instead, dedicated K8s Jobs run on each deployment:

1. Job uses the **worker image** (so it has baked-in env vars: component versions, `GIT_COMMIT`, `BUILD_TIME`)
2. Job waits for API to be ready (`/health` check)
3. Calls `POST /api/v1/agents/:id/versions` with version info
4. FluxCD `force: enabled` annotation ensures Job is deleted+recreated when image tag changes
5. `ttlSecondsAfterFinished: 3600` for auto-cleanup

**Requirements:**
- Update existing `getAgentVersion()` implementations: change from returning `@github/copilot@0.0.415` (CLI binary) to returning the component version prefix (e.g. `copilot-0.0.415`, `vscode-1.111.0-copilot-0.39.0`)
- Add `getComponentVersions()` to each WorkerProcessor (used for stamping request documents)

### Step 4 — Set `workerVersion` at job pickup

**Files:** `packages/shared/src/queue/queue-processor.ts`

In `processOneShot` (and `processMultiTurn` if applicable), when updating status to `"processing"`:
- `agentVersion` — already set via `getAgentVersion()` (now returns version prefix, e.g. `copilot-0.0.415`)
- `workerVersion` — **new field**, built from `<agentVersion>-<BUILD_TIME>-<GIT_COMMIT>` matching image tag:
  ```typescript
  workerVersion: this.processor.getWorkerVersion?.() ?? undefined
  ```
  e.g. `copilot-0.0.415-20260318T163740Z-44d16d6`

### Step 5 — Portal types + API client

**Files:**
- `apps/portal/src/types.ts` — add `AgentVersion` interface, update `CodingAgent`
- `apps/portal/src/lib/api.ts` — add methods:
  - `listAgentVersions(agentId: string, status?: string): Promise<AgentVersion[]>`
  - `registerAgentVersion(agentId: string, version: AgentVersion): Promise<AgentVersion>`
  - `updateAgentVersionStatus(agentId: string, agentVersion: string, status: string): Promise<AgentVersion>`

### Step 6 — Portal UI — agent versions display

**Files:** `apps/portal/src/pages/AgentDetail.tsx`

- Add a "Versions" section to the agent detail view
- List active versions with component details and creation time
- Show retired versions dimmed/collapsed
- Display component breakdown (e.g. "VS Code 1.111.0, Copilot Chat 0.39.0")

### Step 7 — Tests

- **Type tests**: Validate `AgentVersion` shape
- **API tests**: Test version CRUD endpoints (list, register, update status, filtering)
- **Worker registration tests**: Mock HTTP call, verify registration payload
- **Queue processor tests**: Verify `workerVersion` is set on request document

## Notes

- **`agentVersion`** = version prefix from `versions.env` components (e.g. `copilot-0.0.415`, `vscode-1.111.0-copilot-0.39.0`) — identifies the agent software version
- **`workerVersion`** = `<agentVersion>-<timestamp>-<sha>` (e.g. `copilot-0.0.415-20260318T163740Z-44d16d6`) — matches the Docker image tag format from PR #297, identifies the exact deployed build
- `AgentVersion.agentVersion` = PK, one entry per software version in the agent's `versions[]` array
- `AgentVersion.workerVersion` = latest deployed build of that version (updated on each deploy with same component versions)
- `RequestDocument.agentVersion` = FK → `AgentVersion.agentVersion`
- `RequestDocument.workerVersion` = exact build that processed the run
- This is a **breaking change** to `agentVersion` semantics: previously `@github/copilot@0.0.415` (CLI binary), now component version prefix. Existing data is unaffected (old values remain as-is), but new runs will use the new format.
- Registration is best-effort: if the API is unavailable, the worker starts anyway
- `versions.env`, `GIT_COMMIT`, and `BUILD_TIME` env vars are provided by #287 (PR #297, now merged)

## Image tag → workerVersion mapping

PR #297 established these image tag formats per worker:

| Worker | Image tag format | Example |
|--------|-----------------|--------|
| `coder-acp-copilot` | `copilot-<ver>-<ts>-<sha>` | `copilot-0.0.415-20260318T163740Z-44d16d6` |
| `coder-acp-claude-code` | `claude-code-acp-<ver>-sdk-<sdk-ver>-<ts>-<sha>` | `claude-code-acp-0.16.0-sdk-0.2.34-20260318T163730Z-44d16d6` |

`workerVersion` uses the same format. `agentVersion` is the prefix before the timestamp.
