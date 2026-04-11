# Plan: Move Runs Grouping Server Side

**Issue:** https://github.com/growth-ecosystems/scope-core/issues/568

## Problem

Runs grouping is currently implemented client-side in `apps/portal/src/lib/grouping.ts`. The portal fetches **all** runs from `GET /api/v1/requests`, then groups and aggregates them in the browser. This blocks server-side pagination because:

1. Pagination returns a page of runs, but grouping needs visibility across ALL runs to compute correct groups and aggregates.
2. A paginated response can split a group across pages, producing wrong counts, stats, and uniform-value detection.

## Solution

Add a `groupBy` query parameter to the existing `GET /api/v1/requests` endpoint. When absent, the endpoint behaves exactly as today (flat array of runs). When set to `task` or `submissionId`, it runs a MongoDB aggregation pipeline server-side and returns pre-computed group summaries — including all aggregation (turns, duration, tokens stats) and uniform-value detection — so the portal renders them directly with zero client-side computation.

## Steps

### Step 1 — Move shared types to `packages/shared`

Move `GroupByKey`, `AggregateStats`, `GroupAggregates`, `GroupUniformValues`, and `RunGroup` interfaces from `apps/portal/src/lib/grouping.ts` to `packages/shared/src/types/` so both API and portal can import them.

### Step 2 — Add `groupBy` param to `GET /api/v1/requests`

Add optional `groupBy` query param (`"task"` | `"submissionId"`) to the existing list endpoint.

When `groupBy` is provided, run a MongoDB aggregation pipeline:
1. `$match` — same filters as today (worker, taskPromptId, criteria, submissionId, deletedAt)
2. `$addFields` — compute per-run derived values: turn count, total duration (sum of `turn.durationMs`), prompt/completion tokens
3. `$group` — group by `taskPromptId` (or `submissionId`), accumulate min/max/avg/count for turns, duration, tokens; collect first values and distinct-count for uniform-value detection; grab first `scenario.task` for label
4. `$project` — reshape into `RunGroup` response format with `AggregateStats` and `GroupUniformValues`

Response shape when grouped:
```ts
{
  key: string;
  label: string;
  count: number;
  aggregates: GroupAggregates;   // turns, duration, promptTokens, completionTokens stats
  uniform: GroupUniformValues;   // fields identical across all runs in group
}[]
```

When `groupBy` is absent, behavior is unchanged (flat `RequestDocument[]`).

### Step 3 — Server-side aggregation logic

Implement the aggregation computation (stats + uniform values) in a dedicated module `apps/api/src/grouping.ts` that builds the MongoDB pipeline stages. This keeps `index.ts` clean and the logic unit-testable.

The aggregation computes **all** the same metrics the client currently does:
- **Counts**: number of runs per group
- **Stats** (min/max/mean/stdDev): turn count, total duration, prompt tokens, completion tokens
- **Uniform values**: workerType, model, agentVersion, platform, mcpServers, skillRevisions, status, submissionId, task — included only when all runs in the group share the same value

### Step 4 — Portal API client

Update `api.listRuns()` in `apps/portal/src/lib/api.ts` to accept an optional `groupBy` param. Add a separate `api.listRunGroups(opts)` method (or overload) that returns `RunGroup[]` when grouping is requested.

### Step 5 — Update `RunsList.tsx`

When `groupBy !== "none"`:
1. Call `api.listRunGroups(...)` → get `RunGroup[]` from server with pre-computed aggregates.
2. Render group rows directly from server response — no client-side `groupRuns()` call.
3. On group expand, fetch that group's runs via `api.listRuns({ taskPromptId })` or `api.listRuns({ submissionId })`.

When `groupBy === "none"`:
1. Fetch runs via `api.listRuns()` as today.
2. Render flat rows, no grouping.

### Step 6 — Deprecate client-side grouping

Keep `grouping.ts` and its tests intact (no breaking change), but the portal no longer calls `groupRuns()` in the main list view. Can be removed in a follow-up.

### Step 7 — Tests

- **API unit tests** (`apps/api/src/grouping.test.ts`): test the aggregation pipeline builder with different `groupBy` values and filters.
- **API endpoint tests** (`endpoints.test.ts`): test `GET /api/v1/requests?groupBy=task` returns grouped response.
- **Portal tests**: update any `RunsList` tests to use server-side groups.

## File Changes Summary

| File | Change |
|------|--------|
| `packages/shared/src/types/types.ts` | Add `GroupByKey`, `AggregateStats`, `GroupAggregates`, `GroupUniformValues`, `RunGroup` types |
| `apps/api/src/grouping.ts` | New — builds MongoDB aggregation pipeline for grouping + stats + uniform values |
| `apps/api/src/grouping.test.ts` | New — tests for aggregation pipeline builder |
| `apps/api/src/index.ts` | Add `groupBy` query param to list endpoint; call pipeline when set |
| `apps/api/src/endpoints.test.ts` | Test grouped response from list endpoint |
| `apps/portal/src/lib/api.ts` | Add `listRunGroups()` method |
| `apps/portal/src/pages/RunsList.tsx` | Use server groups when grouped; stop calling client-side `groupRuns()` |
| `apps/portal/src/lib/grouping.ts` | Keep as-is (deprecated, not deleted) |

## Risks & Notes

- **CosmosDB aggregation support**: CosmosDB for MongoDB API supports `$group`, `$project`, `$match`, `$sort`, `$addFields`, `$unwind`, `$min`, `$max`, `$avg`, `$push`, `$sum`. `$stdDevPop` is supported in MongoDB 3.2+ — verify CosmosDB compatibility or compute stdDev from pushed arrays in `$project`.
- **Index coverage**: `$group` runs after `$match`, so existing indexes on `workerType`, `taskPromptId`, `submissionId`, `deletedAt`, `createdAt` remain sufficient.
- **Breaking change**: None — `groupBy` is optional; when absent the endpoint returns the same flat array as before.
