# Plan: Paginate Runs List (#567)

**Issue:** https://github.com/growth-ecosystems/scope-core/issues/567
**Branch:** `feat/paginate-runs-list`
**Base:** `main`

## Problem

The runs list endpoint (`GET /api/v1/requests`) fetches **all** matching documents and returns them in a single response. With many runs, this causes:
- Slow page loads
- Large JSON payloads over the wire
- Difficult horizontal scrolling in the portal UI

## Current State

- **Schema** (`ListRequestsQuerySchema`): Already defines `page` (min 1) and `limit` (min 1, max 100) query params — but they are **not wired** into the handler.
- **API handler** (`apps/api/src/index.ts`): Calls `collection.find(filter).sort({ createdAt: -1 }).toArray()` with no skip/limit.
- **API client** (`apps/portal/src/lib/api.ts`): `listRuns()` returns `Promise<Run[]>` with no pagination params.
- **Frontend** (`apps/portal/src/pages/RunsList.tsx`): Renders all runs at once; no pagination controls.

## Approach: Offset-based pagination

Use `page` + `limit` (skip/limit) instead of cursor-based pagination because:
1. The schema already defines `page`/`limit` fields
2. The dataset is sorted by `createdAt` DESC (indexed)
3. Users need to jump to arbitrary pages
4. The UI currently groups and filters client-side — offset fits better with that model

## Tasks

### 1. API: Wire `page`/`limit` into the handler
**File:** `apps/api/src/index.ts`

- Read `page` and `limit` from `req.query` (defaults: `page=1`, `limit=50`)
- Compute `skip = (page - 1) * limit`
- Add `.skip(skip).limit(limit)` to the MongoDB query
- Run a parallel `countDocuments(filter)` to get total count
- Change response shape to a paginated envelope:
  ```ts
  { data: Run[], total: number, page: number, limit: number, totalPages: number }
  ```
- Update the OpenAPI response schema accordingly

### 2. Shared: Add paginated response schema
**File:** `packages/shared/src/schemas/request.ts`

- Create `PaginatedRequestsResponseSchema` wrapping `data`, `total`, `page`, `limit`, `totalPages`
- Export it for use in the API route

### 3. Portal API client: Accept and return pagination
**File:** `apps/portal/src/lib/api.ts`

- Add `page` and `limit` params to `listRuns()`
- Update return type to `PaginatedResponse<Run>` (with `data`, `total`, `page`, `limit`, `totalPages`)

### 4. Portal types: Add paginated response type
**File:** `apps/portal/src/types.ts`

- Add generic `PaginatedResponse<T>` interface

### 5. Portal UI: Add pagination controls to RunsList
**File:** `apps/portal/src/pages/RunsList.tsx`

- Add `page` state (default 1), use a fixed `limit` (e.g. 50)
- Include `page` and `limit` in the `useQuery` key and API call
- Reset page to 1 when filters change
- Display total count and page info (e.g. "Showing 1–50 of 342")
- Add Previous / Next buttons (disable at boundaries)
- Optionally add page number buttons for direct jump
- Grouping should still work within the current page's results

### 6. Tests

- **API handler test**: Verify `page`/`limit` params produce correct `skip`/`limit` in the query and correct envelope shape
- **Portal API client test**: Verify pagination params are sent in the query string
- **Portal UI test**: Verify pagination controls render, page changes trigger re-fetch, buttons disable at boundaries

## Out of Scope

- Cursor-based / continuation-token pagination (can be revisited later)
- Infinite scroll (UX decision — stick with explicit pages for now)
- Virtual scrolling for the table (separate optimization)

## Rollout

- Default `limit=50` keeps current behavior manageable
- No breaking change for callers that don't pass `page`/`limit` — they'll get page 1 with 50 results (behavior change from "all results") — document this in the PR
