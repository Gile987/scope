# Plan: Paginate Runs List (#567)

**Issue:** https://github.com/growth-ecosystems/scope-core/issues/567
**Branch:** `feat/paginate-runs-list`
**Base:** `main`

## Problem

The runs list endpoint (`GET /api/v1/requests`) fetches **all** matching documents and returns them in a single response. With many runs, this causes:
- Slow page loads
- Large JSON payloads over the wire
- Difficult horizontal scrolling in the portal UI

## Current State (post PR #570)

PR #570 moved grouping and filtering server-side. The endpoint now has two modes:

- **Flat mode** (`groupBy` absent): `collection.find(filter).sort({ createdAt: -1 }).toArray()` — still returns **all** matching runs, no pagination.
- **Grouped mode** (`groupBy=task|submissionId`): MongoDB aggregation pipeline returns `RunGroup[]` with server-computed aggregates. Group count is typically small (tens, not thousands).
- **Schema** (`ListRequestsQuerySchema`): Already defines `page` and `limit` query params — not wired into the handler.
- **Portal**: `listRuns()` used for flat mode (`enabled: groupBy === "none"`); `listRunGroups()` used for grouped mode. Separate query keys.
- **Filtering**: `status`, `outcome`, `taskPromptId`, `worker`, `criteria`, `submissionId` all server-side.

## Decision: Paginate flat mode only

Pagination applies to **flat mode only** (`groupBy === "none"`). Rationale:
- Flat mode returns individual runs and can grow to thousands — this is the perf bottleneck.
- Grouped mode returns groups (typically <100). Groups already have `runIds` for lazy expand — pagination of groups is a separate concern.
- Filters already reduce result sets server-side; pagination handles the remaining volume.

## Approach: Offset-based pagination

Use `page` + `limit` (skip/limit) because:
1. The schema already defines `page`/`limit` fields
2. The dataset is sorted by `createdAt` DESC (indexed)
3. Users need to jump to arbitrary pages
4. Offset is the simplest approach and matches the existing paradigm

## Tasks

### 1. API: Wire `page`/`limit` into the flat-mode handler
**File:** `apps/api/src/index.ts` (flat-mode branch, after the `if (groupByParam)` block)

- Read `page` and `limit` from `req.query` (defaults: `page=1`, `limit=50`)
- Compute `skip = (page - 1) * limit`
- Change sort to `{ createdAt: -1, _id: -1 }` to guarantee deterministic ordering (tiebreaker on `_id` prevents duplicates/gaps across pages when multiple runs share the same `createdAt`)
- Add `.skip(skip).limit(limit)` to the MongoDB query
- Run a parallel `countDocuments(filter)` to get total count
- Change flat-mode response shape to a paginated envelope:
  ```ts
  { data: Run[], total: number, page: number, limit: number, totalPages: number }
  ```
- Grouped mode is unchanged — still returns `RunGroup[]`

### 2. Shared: Add paginated response schema
**File:** `packages/shared/src/schemas/request.ts`

- Create `PaginatedRequestsResponseSchema` wrapping `data` (array of `RequestResponseSchema`), `total`, `page`, `limit`, `totalPages`
- Update the route's response schema: `z.union([PaginatedRequestsResponseSchema, z.array(RunGroupSchema)])`

### 3. Portal types: Add paginated response type
**File:** `apps/portal/src/types.ts`

- Add generic `PaginatedResponse<T>` interface

### 4. Portal API client: Accept and return pagination
**File:** `apps/portal/src/lib/api.ts`

- Add `page` and `limit` params to `listRuns()`
- Update return type from `Promise<Run[]>` to `Promise<PaginatedResponse<Run>>`
- `listRunGroups()` unchanged

### 5. Portal UI: Add pagination controls to RunsList
**File:** `apps/portal/src/pages/RunsList.tsx`

- Add `page` state (default 1), use a fixed `limit` (e.g. 50)
- Update the flat-mode `useQuery` to:
  - Include `page` and `limit` in query key and API call
  - Destructure `{ data: runs, total, totalPages }` from the response
- Reset page to 1 when any filter changes (worker, status, outcome, task, criteria, submissionId)
- Display total count and page info (e.g. "Showing 1–50 of 342")
- Add Previous / Next buttons (disable at boundaries)
- Pagination controls hidden when groupBy is active (grouped mode doesn't paginate)

### 6. Tests

- **API handler test** (`apps/api/src/endpoints.test.ts`): Verify flat-mode returns paginated envelope, `page`/`limit` params produce correct skip/limit, total count is correct, grouped mode is unaffected
- **Portal API client test**: Verify `page`/`limit` params are sent in the query string

## Out of Scope

- Cursor-based / continuation-token pagination (can be revisited later)
- Pagination of grouped mode results (groups are typically few; separate issue if needed)
- Infinite scroll / virtual scrolling (separate optimization)

## Rollout

- Default `limit=50` — flat mode returns first page of 50 results instead of all
- Grouped mode unchanged — still returns all groups
- Breaking change for flat mode: response shape changes from `Run[]` to `{ data: Run[], total, page, limit, totalPages }` — document in PR
