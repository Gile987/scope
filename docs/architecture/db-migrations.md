# Database Migrations

Lightweight MongoDB migration framework for evolving the database schema and backfilling data.

## Overview

Migrations live in `packages/db-migrations/`. Each migration is a TypeScript file that exports a class implementing the `Migration` interface. Migrations are:

- **Ordered** — discovered alphabetically by filename, applied in that order
- **Tracked** — a `_migrations` collection records which migrations have been applied
- **Reversible** — each migration implements both `up()` and `down()`
- **Idempotent** — designed to be safe to re-run (upserts, `$setOnInsert`, guards)

## Running Migrations

From the repository root (`scope-mt-app/`):

```bash
# Apply all pending migrations
pnpm migrate:up

# Revert the last applied migration
pnpm migrate:down

# Show migration status (applied vs pending)
pnpm migrate:status
```

### Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` or `COSMOSDB_CONNECTION_STRING` | Yes (one of) | MongoDB connection string |
| `MONGODB_DATABASE` | No | Database name (default: `scope-mt`) |

## Writing a New Migration

1. Create a new file in `packages/db-migrations/src/migrations/` following the naming convention:

   ```
   NNN-description.ts
   ```

   Where `NNN` is a zero-padded sequence number (e.g., `002-add-indexes.ts`).

2. Export a default class implementing the `Migration` interface:

   ```typescript
   import type { Db } from "mongodb";
   import type { Migration } from "../types.js";

   export default class AddIndexes implements Migration {
     description = "Add indexes for common query patterns";

     async up(db: Db): Promise<void> {
       // Apply changes
       await db.collection("requests").createIndex({ taskPromptId: 1 });
     }

     async down(db: Db): Promise<void> {
       // Revert changes (best effort)
       await db.collection("requests").dropIndex("taskPromptId_1");
     }
   }
   ```

3. Test locally with `pnpm migrate:up` and `pnpm migrate:status`.

## How It Works

The migration runner (`packages/db-migrations/src/run.ts`):

1. Scans `src/migrations/` for `.ts`/`.js` files, sorted alphabetically
2. Reads the `_migrations` collection to find already-applied migrations
3. For `up`: applies each pending migration in order, records it in `_migrations`
4. For `down`: reverts the last applied migration, removes its record
5. For `status`: prints a table showing applied (✓) and pending (○) migrations

## Existing Migrations

| Migration | Description |
|-----------|-------------|
| `001-backfill-task-prompts` | Creates `task-prompts` collection from existing `requests.scenario.task` values, links runs via `taskPromptId`, migrates prompt feature extraction data |

## CI/CD

The `db-migrations` package is compiled as part of the CI `build` job (`pnpm -r build` → `tsc`). This catches TypeScript errors in migrations before deployment.

Migrations themselves are **not** run automatically in CI — they require a live database connection and are run manually as part of the deployment process.
