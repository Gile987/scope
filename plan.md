# Plan: Extensions missing on Runs table (#557)

Closes https://github.com/growth-ecosystems/scope-core/issues/557

## Problem

The runs table shows MCP and Skills columns but not Extensions, even though the `extensions` field exists on runs and is configurable when using VS Code electron workers.

## Changes

### 1. Add Extensions column header to the runs table

**File:** `apps/portal/src/pages/RunsList.tsx` (table header section ~line 878)

Add `<TableHead>Extensions</TableHead>` after the Skills header.

### 2. Render Extensions cells in `RunRow`

**File:** `apps/portal/src/pages/RunsList.tsx` (after Skills cell ~line 1010)

Add a `<TableCell>` that renders `run.extensions` as linked badges (same pattern as MCP/Skills), linking to `/extensions/${id}`. Display the extension short name (last segment of the dotted ID, e.g. `python` from `ms-python.python`).

### 3. Render Extensions cells in `GroupRows`

**File:** `apps/portal/src/pages/RunsList.tsx` (after uniform Skills cell ~line 1236)

Add a `<TableCell>` that renders `uniform.extensions` as linked badges with the same pattern.

### 4. Add `extensions` to `GroupUniformValues` and `computeUniformValues`

**File:** `apps/portal/src/lib/grouping.ts`

- Add `extensions?: string[]` to the `GroupUniformValues` interface
- Add extensions uniform computation (same `arrKey` pattern as MCP/Skills) in `computeUniformValues()`

## Testing

- Verify the Extensions column appears on the runs table
- Verify extensions render as clickable badges linking to `/extensions/:id`
- Verify grouped rows show uniform extensions when all runs share the same set
- Run existing tests: `pnpm test`
