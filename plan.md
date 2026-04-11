# Plan: Move Runs Grouping Server Side

**Issue:** https://github.com/growth-ecosystems/scope-core/issues/568

## Problem

Runs grouping is currently implemented client-side in [`apps/portal/src/lib/grouping.ts`](apps/portal/src/lib/grouping.ts). The portal fetches **all** runs from `GET /api/v1/requests`, then groups and aggregates them in the browser. This blocks server-side pagination because:

1. Pagination returns a page of runs, but grouping needs visibility across ALL runs to compute correct groups and aggregates.
2. A paginated response can split a group across pages, producing wrong counts, stats, and uniform-value detection.

## Solution

Add a new **server-side grouping endpoint** that performs the `GROUP BY` and aggregation in CosmosDB/MongoDB, returning pre-computed group metadata. The portal then fetches groups first and drills into individual runs per group on demand.

## Steps

### Step 1 — New `GET /api/v1/requests/groups` endpoint

Add a new API route that accepts:
- All existing filters: `worker`, `taskPromptId`, `criteria`, `submissionId`, `includeDeleted`
- `groupBy`: `"task"` | `"submissionId"` (required)

Returns an array of group summaries (no individual runs):

```ts
interface GroupResponse {
  key: string;           // taskPromptId or submissionId
  label: string;         // human-readable label (task name, submission ID)
  count: number;         // number of runs in group
  aggregates: {
    turns: AggregateStats | null;
    duration: AggregateStats | null;
    promptTokens: AggregateStats | null;
    completionTokens: AggregateStats | null;
  };
  uniform: GroupUniformValues;
}
```

**Implementation:** Use MongoDB aggregation pipeline:
1. `$match` — apply the same filters as the existing list endpoint
2. `$group` — group by `taskPromptId` or `submissionId`, accumulate arrays of per-run values (turn count, duration, tokens) and collect candidate uniform fields
3. `$project` — compute min/max/mean/stdDev from accumulated arrays, detect uniform values

This keeps all computation in the database and returns only lightweight group summaries.

### Step 2 — Add pagination to `GET /api/v1/requests`

Extend the existing list endpoint with:
- `groupKey`: value to filter by (e.g., a specific `taskPromptId` or `submissionId`)
- `groupBy`: which field the key refers to (`"task"` | `"submissionId"`)
- `limit` / `offset` (or `continuationToken` for CosmosDB-native pagination)

When `groupKey` + `groupBy` are provided, the endpoint filters runs to that single group and paginates within it. This is used when the user expands a group row in the UI.

### Step 3 — Move shared types to `packages/shared`

Move the `GroupByKey`, `AggregateStats`, `GroupAggregates`, `GroupUniformValues`, and `RunGroup` interfaces from `apps/portal/src/lib/grouping.ts` to `packages/shared/src/types/` so both API and portal can import them.

### Step 4 — Portal API client

Add `api.listRunGroups(opts)` method in `apps/portal/src/lib/api.ts` that calls the new groups endpoint.

Update `api.listRuns(opts)` to accept `groupKey`, `groupBy`, `limit`, `offset` params.

### Step 5 — Update `RunsList.tsx`

When `groupBy !== "none"`:
1. Fetch groups from `api.listRunGroups(...)` instead of fetching all runs.
2. Render group rows from the server response (no client-side `groupRuns()` call).
3. On group expand, fetch that group's runs via `api.listRuns({ groupBy, groupKey, limit, offset })`.
4. Support "load more" or pagination within an expanded group.

When `groupBy === "none"`:
1. Fetch runs via `api.listRuns({ limit, offset })` with pagination.
2. Render flat rows, no client-side grouping.

### Step 6 — Deprecate client-side grouping

Keep `grouping.ts` and its tests intact for now (no breaking change), but the portal no longer calls `groupRuns()` in the main list view. It can be removed in a follow-up.

### Step 7 — Tests

- **API unit tests** (`endpoints.test.ts`): test the new `/requests/groups` endpoint with different `groupBy` values and filters.
- **API unit tests**: test pagination params on the existing `/requests` endpoint.
- **Portal tests**: update `RunsList` tests if any exist; test the new `api.listRunGroups` client method.

## File Changes Summary

| File | Change |
|------|--------|
| `packages/shared/src/types/types.ts` | Add `GroupByKey`, `AggregateStats`, `GroupAggregates`, `GroupUniformValues`, group response types |
| `apps/api/src/index.ts` | Add `GET /api/v1/requests/groups` route; add `groupKey`/`groupBy`/`limit`/`offset` to list route |
| `apps/api/src/endpoints.test.ts` | Tests for new groups endpoint and pagination |
| `apps/portal/src/lib/api.ts` | Add `listRunGroups()`; extend `listRuns()` with pagination + group filter params |
| `apps/portal/src/pages/RunsList.tsx` | Use server groups when `groupBy !== "none"`; paginate flat list when `groupBy === "none"` |
| `apps/portal/src/lib/grouping.ts` | Keep as-is (deprecated, not deleted) |

## Risks & Notes

- **CosmosDB aggregation pipeline support**: CosmosDB for MongoDB API supports `$group`, `$project`, `$match`, `$sort`, `$addFields`, `$unwind`, and the needed accumulator operators (`$min`, `$max`, `$avg`, `$push`, `$sum`). Standard deviation (`$stdDevPop`) is supported in MongoDB 3.2+ API — verify CosmosDB compatibility or compute it from the pushed array in `$project`.
- **Index coverage**: The `$group` stage operates after `$match`, so existing indexes on `workerType`, `taskPromptId`, `submissionId`, `deletedAt`, `createdAt` should be sufficient.
- **Breaking change**: None — the existing endpoint retains its current behavior when the new params are absent.
