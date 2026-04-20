# Queue Priority, Pause & Resume

> **Status**: Draft  
> **Branch**: `feat/queue-priority-pause-resume`  
> **Date**: 2026-04-19

## Problem Statement

The current worker queueing system is strictly FIFO: requests are pushed into Azure Storage Queues and processed in arrival order. There is no mechanism to:

1. **Prioritize** urgent submissions over routine batch runs
2. **Pause** a submission (or batch) so its pending requests stop being picked up by workers
3. **Resume** a previously paused submission to re-enter the queue

These gaps cause operational friction. A long-running batch of 50 routine submissions blocks an urgent single-submission run. There is no way to "hold" a batch while investigating an issue without cancelling and re-submitting.

## Current Architecture

```
┌────────────┐     ┌────────────────────┐     ┌───────────────────┐
│  API       │     │  Azure Storage     │     │  Worker           │
│  POST      │────▶│  Queue (FIFO)      │────▶│  BaseQueueProc.   │
│  /requests │     │  per worker type   │     │  polls + process  │
└────────────┘     └────────────────────┘     └───────────────────┘
      │                                              │
      ▼                                              ▼
┌────────────────────────────────────────────────────────┐
│                  MongoDB (requests)                     │
│  status: pending → processing → done                   │
│  No priority field. No paused state.                   │
└────────────────────────────────────────────────────────┘
```

### Key files

| File | Role |
|------|------|
| `packages/shared/src/queue/base-queue-processor.ts` | Abstract queue poller, message lifecycle, MongoDB/Redis connections |
| `packages/shared/src/queue/queue-processor.ts` | Coding agent processor (extends base): multi-turn loop, judge, artifacts |
| `packages/shared/src/types/types.ts` | `RequestDocument`, `BaseQueueProcessorConfig`, queue payload types |
| `apps/api/src/routes/requests.ts` | API: creates `RequestDocument`, sends queue message |
| `apps/api/src/routes/reports.ts` | Report queue dispatching |

### What works well (and should be preserved)

- Decoupled architecture: API → queue → worker is horizontally scalable
- Azure Storage Queue is cheap, durable, and low-maintenance
- Visibility timeout prevents message duplication
- Graceful shutdown with in-flight message draining
- `submissionId` already groups requests into batches

---

## Proposed Design

### Approach: Database-Mediated Priority + Pause, Queue as Notification

Instead of replacing Azure Storage Queue, we **layer priority and pause/resume on top** using MongoDB as the scheduling brain. The queue becomes a lightweight notification channel rather than the source-of-truth for ordering.

```
                    ┌─────────────────────────────┐
                    │       MongoDB (requests)     │
                    │                              │
                    │  + priority: number           │
                    │  + status: "paused" state     │
                    │  + pausedAt / resumedAt       │
                    │                              │
                    └───────────┬──────────────────┘
                                │
                    ┌───────────▼──────────────────┐
                    │   Scheduler / Dispatcher     │
                    │   (runs in API or sidecar)   │
                    │                              │
                    │   1. Query pending requests   │
                    │      ORDER BY priority DESC,  │
                    │              createdAt ASC    │
                    │   2. Skip status=paused       │
                    │   3. Atomically claim via     │
                    │      findOneAndUpdate         │
                    │   4. Send to Azure Queue      │
                    └───────────┬──────────────────┘
                                │
                    ┌───────────▼──────────────────┐
                    │   Azure Storage Queue        │
                    │   (notification only)         │
                    │   Message = { requestId }     │
                    └───────────┬──────────────────┘
                                │
                    ┌───────────▼──────────────────┐
                    │   Worker                     │
                    │   polls queue, processes msg  │
                    │   (unchanged from today)      │
                    └──────────────────────────────┘
```

#### Why this approach?

| Alternative | Drawback |
|-------------|----------|
| Multiple Azure queues per priority | Azure Storage Queue has no priority within a queue; N queues = N priority levels, hard to rebalance dynamically |
| Azure Service Bus with sessions/priority | Over-engineered; requires new infra, pricing tier, FluxCD changes |
| Pure database polling (no queue) | Loses the cheap notification benefit; workers busy-poll MongoDB constantly |
| Poison the queue + re-enqueue with delay | Fragile; doesn't solve pause; visibility timeout hacks |

The **hybrid approach** keeps the queue for its notification/wake-up role but moves scheduling decisions to MongoDB where we already store all request state.

---

## Data Model Changes

### RequestDocument (additions)

```typescript
export interface RequestDocument {
  // ... existing fields ...

  /** Scheduling priority. Higher = processed first. Default: 0. */
  priority: number;

  /** Extended status with paused state */
  status: "pending" | "queued" | "processing" | "paused" | "done";

  /** When the request was paused (if status = "paused") */
  pausedAt?: Date;

  /** When the request was last resumed from paused state */
  resumedAt?: Date;

  /** Who paused/resumed (user ID or "system") */
  pausedBy?: string;
}
```

### Status Lifecycle (updated)

```
                         pause()
              ┌──────────────────────────┐
              │                          ▼
  pending ──▶ queued ──▶ processing ──▶ done
              ▲                │
              │    resume()    │
              └────────────────┘
                  paused
```

| Status | Meaning |
|--------|---------|
| `pending` | Just created, not yet picked up by the scheduler |
| `queued` | Scheduler has dispatched it to the Azure queue; awaiting worker |
| `processing` | Worker has dequeued and is actively working on it |
| `paused` | Administratively held; scheduler skips it |
| `done` | Terminal state (with outcome: succeeded / failed / finished) |

### Priority Semantics

| Priority | Use Case |
|----------|----------|
| `100` | Critical / urgent (e.g., demo, live debugging) |
| `50` | High (e.g., blocking PR validation) |
| `0` | Normal (default for all submissions) |
| `-50` | Low / background (e.g., nightly batch runs) |

Priority is a plain integer (not an enum) for maximum flexibility. Higher is more urgent.

### Submission-Level Operations

Since `submissionId` groups requests, pause/resume can operate at both levels:

- **Single request**: `PATCH /api/v1/requests/:id/pause`
- **Entire submission**: `PATCH /api/v1/submissions/:submissionId/pause`

The submission-level endpoint updates all non-terminal requests in that group atomically.

---

## API Changes

### New Endpoints

```
PATCH  /api/v1/requests/:id/pause          Pause a single request
PATCH  /api/v1/requests/:id/resume         Resume a single request
PATCH  /api/v1/requests/:id/priority       Set priority on a single request

PATCH  /api/v1/submissions/:id/pause       Pause all pending/queued in submission
PATCH  /api/v1/submissions/:id/resume      Resume all paused in submission
PATCH  /api/v1/submissions/:id/priority    Set priority on all non-done in submission
```

### Modified Endpoints

- **POST `/api/v1/requests`**: Accept optional `priority` field in body (default: `0`)
- **GET `/api/v1/requests`**: Support `?status=paused` filter and `?sortBy=priority` query param

### Request/Response Examples

```http
POST /api/v1/requests?worker=coder-acp-copilot
Content-Type: application/json

{
  "scenario": { "task": "...", "criteria": ["c1", "c2"] },
  "count": 5,
  "priority": 50
}
```

```http
PATCH /api/v1/submissions/abc-123/pause
→ 200 { "updated": 4, "skipped": 1 }   // 1 already done
```

```http
PATCH /api/v1/requests/req-456/priority
Content-Type: application/json

{ "priority": 100 }
→ 200 { "id": "req-456", "priority": 100 }
```

---

## Scheduler / Dispatcher Design

### Core Constraint: Keep the Queue Shallow

Once a message is in Azure Storage Queue, we **cannot** change its priority, reorder it, or remove it (without consuming it). This means:

- If we dump all pending requests into the queue, we're back to FIFO — priority changes and pause have no effect on already-queued messages.
- The queue must be treated as a **shallow buffer** — only containing the messages that workers will pick up in the near future.

The scheduler therefore operates as a **throttled valve**: it dispatches only as many messages as workers can consume soon, keeping the bulk of pending work in MongoDB where we retain full control.

### Queue Depth Target

The scheduler maintains a **target queue depth per worker type** — the maximum number of `queued` (dispatched but not yet processing) requests at any time.

```
targetQueueDepth = concurrencyPerWorkerType × bufferMultiplier
```

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `concurrencyPerWorkerType` | Configured per worker type, or discovered from replica count | How many requests a worker type can process in parallel |
| `bufferMultiplier` | `1.5` | Small buffer so workers don't starve between scheduler ticks |

**Example**: If `coder-acp-copilot` has 3 replicas, each processing 1 request at a time → `concurrency = 3`, `targetQueueDepth = ceil(3 × 1.5) = 5`. The scheduler will only dispatch new messages when the current `queued` count for that worker type drops below 5.

### Dispatch Algorithm

```
for each workerType:
  currentQueued = count({ status: "queued", workerType })
  slots = targetQueueDepth[workerType] - currentQueued

  if slots <= 0: continue  // queue is full enough

  for i in 0..slots:
    claimed = findOneAndUpdate(
      { status: "pending", workerType, deletedAt: null },
      { $set: { status: "queued", updatedAt: now } },
      { sort: { priority: -1, createdAt: 1 } }
    )
    if !claimed: break  // no more pending work for this worker type
    sendToQueue(claimed)
```

This ensures:
- **Priority takes effect quickly**: when a high-priority request arrives, it gets dispatched on the next tick (within seconds), ahead of lower-priority pending requests — because the queue only has a few messages in it.
- **Pause takes effect quickly**: paused requests are skipped by the scheduler. Already-queued messages drain naturally (workers finish them), and no new messages for paused requests are added.
- **Priority changes are respected**: if you bump a pending request's priority, the next scheduler tick will pick it up in the new order.

### What happens to already-queued messages when you pause?

When a request is paused while `status: "queued"` (already dispatched to the queue), the message is still in Azure Storage Queue. The worker will dequeue it, check MongoDB, see `status: "paused"`, **delete the message**, and move on. No work is wasted — the check happens before any expensive processing.

When resumed, the status goes back to `"pending"`, and the scheduler re-dispatches it on the next tick in priority order.

### Scheduler Implementation (Phase 1: In-Process)

```typescript
// packages/shared/src/queue/request-scheduler.ts

export interface WorkerTypeConfig {
  workerType: string;
  queueClient: QueueClient;
  targetQueueDepth: number;  // max queued messages for this worker type
}

export class RequestScheduler {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private collection: Collection<RequestDocument>,
    private workerTypes: WorkerTypeConfig[],
    private pollIntervalMs: number = 2000,
  ) {}

  start(): void {
    this.interval = setInterval(() => this.dispatch(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private async dispatch(): Promise<void> {
    for (const wt of this.workerTypes) {
      try {
        await this.dispatchForWorkerType(wt);
      } catch (err) {
        console.error(`[Scheduler] Error dispatching for ${wt.workerType}:`, err);
      }
    }
  }

  private async dispatchForWorkerType(wt: WorkerTypeConfig): Promise<void> {
    // Use the actual Azure queue depth — not MongoDB — as the source of truth
    const properties = await wt.queueClient.getProperties();
    const currentDepth = properties.approximateMessagesCount ?? 0;

    const slots = wt.targetQueueDepth - currentDepth;
    if (slots <= 0) return;

    for (let i = 0; i < slots; i++) {
      const claimed = await this.collection.findOneAndUpdate(
        {
          status: "pending",
          workerType: wt.workerType,
          deletedAt: { $exists: false },
        },
        { $set: { status: "queued", updatedAt: new Date() } },
        { sort: { priority: -1, createdAt: 1 }, returnDocument: "after" }
      );

      if (!claimed) break;  // no more pending work

      const message = Buffer.from(
        JSON.stringify({ requestId: claimed._id })
      ).toString("base64");
      await wt.queueClient.sendMessage(message);
    }
  }
}
```

### Phase 2: Sidecar Scheduler (if needed)

If the API process becomes a bottleneck, extract the scheduler into a standalone container:

- Separate Kubernetes Deployment (1 replica with leader election)
- Same logic, own health check endpoint
- Allows independent scaling and deployment

### Why `findOneAndUpdate` with sort?

- **Atomic claim**: prevents two scheduler instances (or replicas) from claiming the same request
- **Priority ordering**: `sort: { priority: -1, createdAt: 1 }` ensures highest priority first, then FIFO within the same priority
- **CosmosDB compatible**: CosmosDB for MongoDB supports `findOneAndUpdate` with sort (requires composite index)

---

## Worker Changes

### Minimal changes required

Workers **do not need to understand priority or pause**. They continue to:

1. Poll Azure Storage Queue
2. Receive `{ requestId }` messages
3. Fetch document from MongoDB
4. Process it

The only addition: when a worker fetches a document and sees `status: "paused"`, it should **delete the message and skip processing**. The request stays in MongoDB as `paused` — the scheduler will re-dispatch it when resumed.

```typescript
// In base-queue-processor.ts processMessage():

const doc = await this.collection.findOne({ _id: documentId });

if (!doc) {
  await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  return;
}

// NEW: Skip paused requests — delete message, leave doc as paused
if (doc.status === "paused") {
  console.log(`[${this.workerName}] Request ${documentId} is paused, dropping queue message`);
  await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  return;
}
```

### Race condition: pause during processing

If a request is paused while a worker is already processing it, the current run completes. Pause only affects **pending/queued** requests. This is by design — interrupting a running coding agent mid-session would waste the work already done.

---

## Database Indexes

### New indexes required

```javascript
// Priority scheduling query (per worker type)
db.requests.createIndex(
  { status: 1, workerType: 1, deletedAt: 1, priority: -1, createdAt: 1 },
  { name: "idx_scheduler_dispatch" }
);

// Pause/resume by submissionId
db.requests.createIndex(
  { submissionId: 1, status: 1 },
  { name: "idx_submission_status" }
);
```

For CosmosDB: these map to composite indexes in the indexing policy.

---

## Migration Strategy

### Database migration

1. Add `priority` field with default `0` to all existing documents
2. Existing `status` values are unchanged (`pending`, `processing`, `done`)
3. New `queued` and `paused` states only appear for newly created documents
4. Backfill migration: `db.requests.updateMany({ priority: { $exists: false } }, { $set: { priority: 0 } })`

### Rollout plan

| Phase | Scope | Risk |
|-------|-------|------|
| **Phase 1: Priority only** | Add `priority` to `RequestDocument`, modify submit endpoint, add `sortBy=priority` to list. Scheduler loop in API. | Low — additive change, existing requests get priority=0 |
| **Phase 2: Pause/Resume** | Add `paused` status, pause/resume endpoints, worker skip logic | Medium — new state transitions, need UI integration |
| **Phase 3: Scheduler extraction** | Move scheduler to sidecar if API load requires it | Low — same logic, different process |
| **Phase 4: Portal UI** | Priority selector on submit form, pause/resume buttons on submission list | Low — frontend only |

---

## Implementation Tasks

### Phase 1: Priority Scheduling

- [ ] Add `priority: number` to `RequestDocument` type
- [ ] Add `status: "queued"` to status union type
- [ ] Create database migration to add `priority` default and composite index
- [ ] Modify `POST /api/v1/requests` to accept `priority` body param
- [ ] Implement `RequestScheduler` class in `packages/shared/src/queue/`
- [ ] Integrate scheduler startup in API `app.ts`
- [ ] Modify API submit flow: insert as `pending` (don't send to queue directly)
- [ ] Add `PATCH /api/v1/requests/:id/priority` endpoint
- [ ] Add `PATCH /api/v1/submissions/:id/priority` endpoint
- [ ] Update request list endpoint with `sortBy=priority` support
- [ ] Add unit tests for scheduler dispatch ordering
- [ ] Add unit tests for priority API endpoints
- [ ] Add integration test: high-priority request processed before low-priority

### Phase 2: Pause/Resume

- [ ] Add `status: "paused"` to status union type
- [ ] Add `pausedAt`, `resumedAt`, `pausedBy` fields to `RequestDocument`
- [ ] Add `PATCH /api/v1/requests/:id/pause` endpoint
- [ ] Add `PATCH /api/v1/requests/:id/resume` endpoint
- [ ] Add `PATCH /api/v1/submissions/:id/pause` endpoint
- [ ] Add `PATCH /api/v1/submissions/:id/resume` endpoint
- [ ] Modify scheduler to skip `paused` requests
- [ ] Modify worker `processMessage()` to handle `paused` documents
- [ ] Add unit tests for pause/resume state transitions
- [ ] Add unit tests for submission-level pause/resume
- [ ] Update SSE log streaming to emit pause/resume events

### Phase 3: Portal UI

- [ ] Add priority selector to submission form
- [ ] Add pause/resume buttons to submission list & detail views
- [ ] Show priority badge on request cards
- [ ] Add "paused" status chip styling

---

## Open Questions

1. **Should pause cancel in-flight work?** Current proposal: no — only affects pending/queued. Cancelling a running coding agent is destructive. We could add a separate "cancel" action later.

2. **Should priority be immutable after queued?** Changing priority on a `queued` request has no effect until the message drains from the queue and the request returns to `pending` (e.g. via pause→resume). This is acceptable because the queue is kept shallow — messages spend seconds in it, not minutes. Priority changes on `pending` requests take effect immediately on the next scheduler tick.

3. **Scheduler leader election**: If we run multiple API replicas, `findOneAndUpdate` ensures atomicity. But multiple schedulers polling the same collection increases load. Options:
   - Single scheduler replica (Phase 2 sidecar)
   - Distributed lock (Redis `SET NX`)
   - Accept the overhead (MongoDB handles it fine at our scale)

4. **Priority inheritance for resubmits**: When using `POST /api/v1/requests/bulk/resubmit`, should the new requests inherit the original priority? Proposal: yes, unless overridden in the resubmit body.
