# Queue Priority, Pause & Resume

> **PR**: #689 (`feat/queue-priority-pause-resume`)

## Overview

The scheduling system decouples request ordering from message delivery. MongoDB is the scheduling brain — it stores priority, enforces pause/resume state, and determines dispatch order. Azure Storage Queues remain the notification channel that wakes workers, but are kept deliberately shallow so scheduling decisions in MongoDB take effect within seconds.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          MongoDB (requests)                            │
│                                                                        │
│  priority: number (root, request-scoped)                               │
│  run.status: pending | queued | paused | processing | done             │
│  run.pausedAt / run.resumedAt (per-attempt)                            │
│                                                                        │
│  Compound index: run.status + workerType + deletedAt + priority + date │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
               ┌───────────────▼───────────────┐
               │     Request Scheduler          │
               │     (apps/scheduler/)          │
               │     1 replica, polls every 2s  │
               │                                │
               │  findOneAndUpdate              │
               │    filter: status=pending      │
               │    sort: priority DESC,        │
               │          createdAt ASC         │
               │    set: status → queued        │
               │                                │
               │  Caps queue at targetDepth     │
               │  via getProperties() count     │
               └───────────────┬───────────────┘
                               │
               ┌───────────────▼───────────────┐
               │   Azure Storage Queues         │
               │   (shallow buffer, ≤5 msgs)    │
               │   queue-coder-acp-copilot      │
               │   queue-coder-acp-claude-code  │
               │   queue-coder-vscode-electron… │
               └───────────────┬───────────────┘
                               │
               ┌───────────────▼───────────────┐
               │   Workers                      │
               │   Poll queue → fetch doc →     │
               │   check status (skip paused)   │
               │   → process                    │
               └───────────────────────────────┘
```

## Data Model

### Priority

`priority` is a root-level integer on `RequestDocument`. Higher values are dispatched first. Default is `0`.

| Value | Use case |
|-------|----------|
| 100 | Critical / demo |
| 50 | High / blocking PR |
| 0 | Normal (default) |
| −50 | Low / nightly batch |

Priority is request-scoped (survives retries). The range is unrestricted but the portal offers −10 to +10 via the bulk dialog, with ±1/±5 increment buttons.

### Status Lifecycle

```
              pause()
  pending ──────────────▶ paused
     │        pause()       │
     │   ┌── queued ──▶ paused
     │   │                  │
     │   │     resume()     │
     │   │   (→ pending)    │
     │   └──────────────────┘
     │
     ▼  (scheduler)
  queued ──▶ processing ──▶ done
```

| Status | Meaning |
|--------|---------|
| `pending` | Awaiting scheduler dispatch. Can be paused. |
| `queued` | Dispatched to Azure queue, awaiting worker pickup. Can be paused. |
| `processing` | Worker actively running. Cannot be paused. |
| `paused` | Held — scheduler skips. Resume returns to `pending`. |
| `done` | Terminal (outcome: succeeded / failed / finished). |

`pausedAt` and `resumedAt` are per-attempt fields in `RunState`. On retry, a fresh `RunState` is created with `status: "pending"`.

## Request Scheduler

**Location**: `apps/scheduler/` — standalone K8s Deployment (1 replica, `Recreate` strategy).

### Dispatch Loop

Every 2 seconds (configurable via `SCHEDULER_POLL_INTERVAL_MS`):

1. For each worker type, read Azure queue depth via `getProperties().approximateMessagesCount`
2. Compute available slots: `targetQueueDepth − currentDepth`
3. For each slot, `findOneAndUpdate` the highest-priority pending request:
   - Filter: `run.status: "pending"`, matching `workerType`, no `deletedAt`
   - Sort: `priority: -1, createdAt: 1`
   - Update: set `run.status: "queued"`
4. Send `{ requestId, runId }` message to Azure Storage Queue (base64-encoded JSON)

### Configuration

Environment variables in `deploy/base/scheduler.yaml`:

| Variable | Value | Purpose |
|----------|-------|---------|
| `SCHEDULER_QUEUE_DEPTH_<TYPE>` | 3–5 | Target queue depth per worker type |
| `SCHEDULER_POLL_INTERVAL_MS` | 2000 | Polling interval in ms |

Queue names follow the convention `queue-<workerType>` (e.g. `queue-coder-acp-copilot`).

### Why Keep the Queue Shallow?

Once a message is in Azure Storage Queue, it cannot be reordered or removed. By capping queue depth at 3–5 messages per worker type:

- **Priority takes effect immediately**: high-priority requests get dispatched on the next tick
- **Pause takes effect immediately**: paused requests are never dispatched
- **Priority changes are respected**: pending requests re-sort on the next tick

## Worker Behavior

Workers are unchanged except for one guard: after fetching a document from MongoDB, if `run.status === "paused"`, the worker deletes the queue message and moves on. This handles the race where a request was paused after being queued but before the worker picked it up.

## API Endpoints

### Single Request

```
POST /api/v1/requests/:id/pause       Pause (pending/queued → paused)
POST /api/v1/requests/:id/resume      Resume (paused → pending)
POST /api/v1/requests/:id/priority    Set priority { priority: number }
```

### Bulk Operations

```
POST /api/v1/requests/bulk-pause      { ids: string[] }
POST /api/v1/requests/bulk-resume     { ids: string[] }
POST /api/v1/requests/bulk-priority   { ids: string[], priority: number }
```

All endpoints use POST. Bulk endpoints return `{ updated, skipped }` counts. Priority endpoints filter server-side to only update `pending` and `paused` requests.

### Submit

`POST /api/v1/requests` accepts an optional `priority` field (default: 0). The API inserts with `run.status: "pending"` — it no longer sends directly to the queue. The scheduler handles dispatch.

## Portal UI

### Runs List Toolbar

The bulk action bar appears when runs are selected. Buttons progressively collapse labels at narrower viewports (icons always visible, tooltips on all buttons):

| Breakpoint | Visible |
|------------|---------|
| ≥ 2xl | Section labels + all button text |
| xl–2xl | Button text only (section labels hidden) |
| lg–xl | Core action text (Pause/Resume/Retry); Export text hidden |
| md–lg | Only Pause/Resume/Retry text; Priority/Re-submit icon-only |
| < md | All icon-only |

Buttons are disabled (not hidden) when the action doesn't apply to the selection. `selectionCaps` computes pausable/resumable/prioritizable/retryable counts from either the flat `runs` array (flat mode) or group-level `statusCounts` (grouped mode).

The bulk priority dialog has −5/−1/input/+1/+5 increment controls and pre-fills with the current priority of selected runs.

### Run Detail Page

The header shows context-sensitive schedule actions alongside existing Retry/Archive buttons:

- **Pause** — visible when status is `pending` or `queued`
- **Resume** — visible when status is `paused`
- **Priority** dropdown — visible when `pending` or `paused`, with preset levels (−10 to +10)

All actions are hidden when viewing a historical attempt.

### Per-Row Actions

Each row in the runs table has inline icon buttons for Pause (pending/queued), Resume (paused), Priority dropdown (pending/paused), and Retry (done).

### Status Display

- `queued` → purple badge
- `paused` → warning/amber badge
- Group rows show stacked status progress bars with all 5 states

## Database Migration

`015-add-priority-and-scheduler-index.ts`:

1. Backfills `priority: 0` on all documents missing it
2. Creates compound index: `{ "run.status": 1, workerType: 1, deletedAt: 1, priority: -1, createdAt: 1 }`

## Infrastructure

### Kubernetes Resources

| Resource | File |
|----------|------|
| Scheduler Deployment | `deploy/base/scheduler.yaml` |
| Azure Storage Queues (ASO) | `deploy/base/queues.yaml` |
| Scheduler in docker-compose | `docker-compose.yml` (service: `scheduler`) |

### Queue Inventory

| Queue | Worker Type |
|-------|-------------|
| `queue-coder-acp-copilot` | GitHub Copilot CLI |
| `queue-coder-acp-claude-code` | Claude Code |

## Key Files

| File | Role |
|------|------|
| `apps/scheduler/src/request-scheduler.ts` | Scheduler core: dispatch loop, queue depth management |
| `apps/scheduler/src/index.ts` | Entry point: config parsing, MongoDB/Queue setup, health server |
| `apps/api/src/routes/requests.ts` | Pause/resume/priority endpoints (single + bulk) |
| `packages/shared/src/types/types.ts` | `priority`, `queued`/`paused` status, `pausedAt`/`resumedAt` |
| `packages/shared/src/queue/base-queue-processor.ts` | Worker paused-check guard |
| `packages/db-migrations/src/migrations/015-add-priority-and-scheduler-index.ts` | Migration |
| `apps/portal/src/pages/RunsList.tsx` | Bulk actions toolbar, per-row actions |
| `apps/portal/src/pages/RunDetail.tsx` | Detail page schedule actions |
| `apps/api/src/grouping.ts` | Group aggregates (includes `llmCalls`) |
| `deploy/base/scheduler.yaml` | K8s Deployment manifest |
| `deploy/base/queues.yaml` | ASO StorageQueue resources |
