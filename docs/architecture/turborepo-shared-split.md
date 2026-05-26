# Turborepo Integration & Shared Package Split

## Status

- **Phase 1: Split `packages/shared`** - ✅ COMPLETE
- **Phase 2: Integrate Turborepo** - Pending (separate PR)
- **Phase 3: Optimize Docker builds** - Pending (separate PR)

## Problem

Every change to `packages/shared` triggered a full rebuild of **all Docker images** because:

1. No build orchestration - `pnpm -r build` rebuilds everything sequentially
2. `shared` was a monolithic package (~20 submodules, 304 exported symbols) consumed by 12 apps
3. Each Dockerfile runs `pnpm --filter shared build` independently - no caching between images
4. No TypeScript project references - no incremental compilation

## Solution: Package Split (Phase 1 - Complete)

The monolithic `packages/shared` has been split into 6 fine-grained packages:

| Package | Folder | Contents | Rationale |
| --- | --- | --- | --- |
| **@scope/core** | `packages/core/` | types/, schemas/, utils/, cursor.ts, agent-version.ts, resolve-agent-version.ts | Universal leaf package. Types + utilities with no internal deps. |
| **@scope/secrets** | `packages/secrets/` | token-manager/ | Token/key management. Small surface, changes independently. |
| **@scope/platform** | `packages/platform/` | extensions/, task-prompts/, report-templates/, storage/, prompt-features/, har/ | Platform domain services. |
| **@scope/agent-protocol** | `packages/agent-protocol/` | mcp/, devproxy/, skills/, chat-export/ | Agent interaction layer. |
| **@scope/criteria** | `packages/criteria/` | criteria/, graph/ | Evaluation criteria and DAG. Only consumed by judge app. |
| **@scope/worker-runtime** | `packages/worker-runtime/` | queue/, workers/, logging/, judge/ | Worker orchestration runtime. |

### Dependency DAG (no cycles)

```
@scope/core (leaf - no deps)
@scope/secrets -> core
@scope/platform -> core
@scope/criteria -> core
@scope/agent-protocol -> core, platform
@scope/worker-runtime -> core, platform, agent-protocol
```

### Blast Radius (after split)

| Package Changed | Images Rebuilt | Which |
| --- | --- | --- |
| @scope/criteria | **1** | judge |
| @scope/platform | **3** | api, judge, report-gen |
| @scope/agent-protocol | **5** | api, copilot, copilot-win, claude, vscode-electron |
| @scope/worker-runtime | **8** | all worker consumers |
| @scope/secrets | **10** | most apps (via token-manager) |
| @scope/core | **12** | all (universal dependency) |

**vs. before**: ANY change rebuilt ALL 12+ images.

## Phase 2: Integrate Turborepo (Pending)

### 2.1 Install

```bash
pnpm add -Dw turbo
```

Add `.turbo/` to `.gitignore`.

### 2.2 Create `turbo.json`

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json", "package.json"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["build"]
    }
  }
}
```

### 2.3 Update root scripts

```json
{
  "build": "turbo run build",
  "lint": "turbo run lint",
  "test": "turbo run test"
}
```

### 2.4 Remote Caching

Use self-hosted cache on Azure Blob (via `turborepo-remote-cache` by ducktors) or GitHub Actions cache (via `rharkor/caching-for-turbo`). No org data leaves our infrastructure.

## Phase 3: Optimize Docker Builds (Pending)

### 3.1 Use `turbo prune` for minimal Docker contexts

```dockerfile
FROM node:22-alpine AS pruner
RUN corepack enable
COPY . .
RUN turbo prune api --docker

FROM node:22-alpine AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
COPY --from=pruner /app/out/full/ .
COPY --from=installer /app/node_modules ./node_modules
RUN turbo run build --filter=api
```

### 3.2 Update docker-compose watch paths

Replace blanket `packages/shared/src` watch with specific package paths per service.

### 3.3 Update `build-acr.sh`

Use `turbo prune` to generate minimal build contexts per image.

## Implementation Order

Each phase gets its own PR:

1. **PR #950: Phase 1** - Split packages ✅ COMPLETE
2. **PR: Phase 2** - Turborepo integration
3. **PR: Phase 3** - Docker build optimization

## Parallel Work Note

PR #945 (UX v2) is entirely in `apps/portal/` and has no conflict with this work.
