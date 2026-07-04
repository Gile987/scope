# Database Migrations

MongoDB migration framework powered by [mongo-migrate-ts](https://github.com/mycodeself/mongo-migrate-ts) for evolving the database schema and backfilling data.

## Overview

Migrations live in `packages/db-migrations/`. Each migration is a TypeScript file that exports a named class implementing the `MigrationInterface` from `mongo-migrate-ts`. Migrations are:

- **Ordered** — discovered alphabetically by filename, applied in that order
- **Tracked** — a `_migrations` collection records which migrations have been applied (stores `className` and `timestamp`)
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

# Scaffold a new migration file
pnpm migrate:new
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` or `MONGO_CONNECTION_STRING` or `COSMOSDB_CONNECTION_STRING` | No | MongoDB connection string (default: `mongodb://localhost:27117`) |
| `MONGODB_DATABASE` or `MONGO_DATABASE` | No | Database name (default: `requests-db`) |

Defaults match the `docker-compose.yml` local dev environment, so no configuration is needed for local development.

## Writing a New Migration

1. Create a new file in `packages/db-migrations/src/migrations/` following the naming convention:

   ```
   NNN-description.ts
   ```

   Where `NNN` is a zero-padded sequence number (e.g., `002-add-indexes.ts`).

2. Export a **named** class implementing `MigrationInterface`:

   ```typescript
   import type { Db } from "mongodb";
   import type { MigrationInterface } from "mongo-migrate-ts";

   export class AddIndexes implements MigrationInterface {
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

   > **Important**: Use a **named export** (not `export default`). `mongo-migrate-ts` discovers migrations by iterating over all named exports from each file and uses the class name as the migration identifier in the `_migrations` collection.

3. Keep migrations **self-contained** — avoid importing from workspace packages (e.g., `shared`). `mongo-migrate-ts` dynamically imports migration files, which can break workspace package resolution. Inline any shared utilities directly in the migration file.

4. Test locally with `pnpm migrate:up` and `pnpm migrate:status`.

### Common patterns

- **RU-paced backfill** — use `batchUpdate(col, filter, update, label)` from `../batch-update.js` (collects `_id`s, then `updateMany({_id:{$in:batch}}, update)` in small batches with 429 retry). Static update only.
- **Per-document backfill referencing `_id`** — when the new value derives from each doc's own `_id` (e.g. `keyId = _id`), `batchUpdate` can't express it. Use a paced `bulkWrite` loop of `updateOne` ops instead (mirror `025-create-projects`), reusing `BATCH_SIZE`/`sleep`/`getRetryAfterMs` for pacing and 429 handling.
- **Idempotent index create** — wrap `createIndex` in try/catch and tolerate "already exists" codes (`85`/`86`/`68`); rethrow real failures so validation surfaces them.
- **Unique-index swap** — before creating a composite **unique** index on a non-empty collection, `$group`/`$match` to assert no duplicate keys exist first (a pre-existing collision fails index creation on Cosmos). Drop the old index tolerating "not found" (`26`/`27`). `down()` for index ops is log-only by convention.

## How It Works

The CLI entry point (`packages/db-migrations/src/migrate.ts`) configures `mongo-migrate-ts` with:

- Connection URI and database name from environment variables (with local dev defaults)
- Migration directory: `src/migrations/`
- Collection name: `_migrations`
- Glob pattern: `**/*.ts`

When you run a command:

1. `up` — applies all pending migrations in order, records each in the `_migrations` collection with `className` and `timestamp`
2. `down --last` — reverts the last applied migration, removes its record
3. `status` — prints a table showing applied (`up`) and pending migrations
4. `new` — scaffolds a new migration file in the migrations directory

## Existing Migrations

| Migration | Description |
|-----------|-------------|
| `001-backfill-task-prompts` | Creates `task-prompts` collection from existing `requests.scenario.task` values, links runs via `taskPromptId`, migrates prompt feature extraction data |
| `002-create-indexes` | Creates single-field indexes on all collections (see [db.md](db.md)) |
| `003-create-skill-indexes` | Adds indexes for `skills` and `skill-revisions` collections |
| `004-add-submission-id-index` | Sparse index on `requests.submissionId` for efficient filtering |
| `005-backfill-iteration-durations` | Estimates `startedAt`/`durationMs` on existing turns from timestamps |
| `006-split-status-outcome` | Splits run status into `status` (pending/processing/done) + `outcome` (succeeded/failed/exhausted) |
| `007-rename-exhausted-to-finished` | Renames outcome `exhausted` → `finished` |
| `008-backfill-ai-call-count` | Downloads HARs from blob storage to count AI completion calls per turn |
| `009-add-requests-filter-indexes` | Adds indexes on `taskPromptId`, `status`, `outcome`, `workerType`, `deletedAt` for server-side filtering/grouping |
| `025-create-projects` | Data Organization: Projects — seeds one initial project and backfills immutable `projectId` on all 16 scoped collections; backfills `task-prompts.keyId = _id`; swaps deterministic-key unique indexes to `{projectId,keyId}` / `{projectId,ref}` and adds `{projectId}` scoping indexes (see [db.md](db.md#project-scoping-migration-025)) |

## CI/CD

The `db-migrations` package is compiled as part of the CI `build` job (`pnpm -r build` → `tsc`). This catches TypeScript errors in migrations before deployment.

In Kubernetes, migrations are run automatically by a Job before the API pods start. Locally, Docker Compose runs migrations automatically as well. The API readiness probe checks the `_migrations` collection against the `REQUIRED_MIGRATIONS` list — pods report "not ready" until all required migrations have been applied.
