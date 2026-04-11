# Plan: Switch submission IDs from UUIDv4 to UUIDv7

Tracks: https://github.com/growth-ecosystems/scope-core/issues/572

## Goal

Replace `uuidv4()` with `uuidv7()` for submission IDs (and other generated IDs) in the API so that IDs are naturally time-ordered. This enables the runs list page to sort grouped submissions chronologically without relying on a separate timestamp field.

## Analysis

### Files to change

**`apps/api/src/index.ts`** — 11 call sites using `uuidv4()`:
| Line | Purpose | Change to v7? |
|------|---------|---------------|
| 7 | Import `v4 as uuidv4` | Replace with `v7 as uuidv7` |
| 772 | `submissionId = uuidv4()` | Yes — primary target |
| 781 | `requestId = uuidv4()` | Yes |
| 837 | `requestId = uuidv4()` | Yes |
| 1184 | `submissionId = uuidv4()` (rerun endpoint) | Yes — primary target |
| 1191 | `requestId = uuidv4()` | Yes |
| 1996 | fallback `submissionId: uuidv4()` | Yes — primary target |
| 3071 | `reportId = uuidv4()` | Yes |
| 3167 | `reportId = uuidv4()` | Yes |
| 3545 | `reportId = uuidv4()` | Yes |
| 3619 | `reportId = uuidv4()` | Yes |
| 5783 | `_id: uuidv4()` (insight doc) | Yes |

**`apps/token-manager/src/account-routes.ts`** — 1 call site:
| Line | Purpose | Change to v7? |
|------|---------|---------------|
| 3 | Import `v4 as uuidv4` | Replace with `v7 as uuidv7` |
| 49 | `id = uuidv4()` (account creation) | Yes |

**`apps/token-manager/src/routes.ts`** — 1 call site:
| Line | Purpose | Change to v7? |
|------|---------|---------------|
| 3 | Import `v4 as uuidv4` | Replace with `v7 as uuidv7` |
| 89 | `id = uuidv4()` (token creation) | Yes |

### Files NOT changing

- `packages/shared/src/skills/skill-revision-id.ts` — uses `uuidv5` (deterministic). No change.
- `packages/shared/src/task-prompts/task-prompt-id.ts` — uses `uuidv5` (deterministic). No change.
- `packages/db-migrations/src/migrations/001-backfill-task-prompts.ts` — uses `uuidv5` (deterministic). No change.

## Steps

1. **`apps/api/src/index.ts`**: Change import from `v4 as uuidv4` to `v7 as uuidv7`. Replace all `uuidv4()` calls with `uuidv7()`.
2. **`apps/token-manager/src/account-routes.ts`**: Same import swap + replace.
3. **`apps/token-manager/src/routes.ts`**: Same import swap + replace.
4. **Run tests**: `pnpm test` to verify nothing breaks (UUID format is identical, just different generation strategy).

## Backwards compatibility

- UUIDv7 produces the same 36-character hyphenated string format as v4.
- Existing v4 IDs in the database remain valid — no migration needed.
- Mixed v4/v7 ordering: old v4 IDs won't sort chronologically, but they'll age out of active views. New v7 IDs will sort correctly from the moment of deployment.
