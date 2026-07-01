// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add a compound sort index `{ deletedAt: 1, id: 1 }` to the
 * `criteria` collection so Cosmos DB can serve `ORDER BY id`.
 *
 * `CriteriaStore.getAll()` runs:
 *
 *   find({ deletedAt: { $exists: false } }).sort({ id: 1 })
 *
 * On Azure Cosmos DB for MongoDB (RU-based) this fails with:
 *
 *   BadRequest (400) ... "The index path corresponding to the specified
 *   order-by item is excluded."
 *
 * The `criteria` collection already has a **unique** index on `{ id: 1 }`
 * (migration 002), but in Cosmos a unique index is a uniqueness *constraint*,
 * not a **range** index — it does NOT satisfy `ORDER BY id`. Only a range /
 * composite index on the sort path can serve the sort.
 *
 * A plain non-unique `{ id: 1 }` index can't be added because it shares the
 * same key pattern as the existing unique index. A 2-field **compound**
 * `{ deletedAt: 1, id: 1 }` has a distinct key pattern, so it coexists with the
 * unique index, and it exactly matches the query shape (filter `deletedAt`,
 * sort `id`) — the pattern recommended by the `cosmosdb-mongodb` skill for
 * `ORDER BY`, mirroring migration 016.
 *
 * Validated against the shared dev Cosmos account: with this index, the query
 * succeeds; without it (unique-only, the prod state) it reproduces the 400.
 *
 * Fixes #1192 (create-with-dependency) and #1103 (update-dependency); both
 * reach `getAll()` via `validateNoCycles()`.
 *
 * CosmosDB silently ignores indexes it cannot support, so validate with
 * `db.criteria.getIndexes()` after applying.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddCriteriaSortIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("criteria");
    try {
      await col.createIndex({ deletedAt: 1 as const, id: 1 as const });
      console.log("[024] Created index deletedAt_1_id_1 on criteria");
    } catch (err: any) {
      console.log(
        `[024] Index deletedAt_1_id_1 already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(_db: Db): Promise<void> {
    console.log(
      "[024-down] Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
