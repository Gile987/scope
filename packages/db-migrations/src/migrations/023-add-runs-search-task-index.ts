// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add a single-field index on `scenario.task` for the requests
 * collection so the Runs-list free-text search is fully index-served on
 * Cosmos DB (issue #1138 follow-up).
 *
 * The Runs-list search is a case-insensitive `$regex` `$or` across `_id`,
 * `taskPromptId`, `model`, `workerType`, and `scenario.task`. On Cosmos DB for
 * MongoDB (RU), a single *unindexed* branch in an `$or` forces the whole query
 * to load every document (a full container scan) even when the other branches
 * are index-served. The first four fields already have single-field indexes
 * (migrations 009 / 021); `scenario.task` (the task prompt text) did not, so it
 * was the sole reason `?search=` degraded to a full scan.
 *
 * Indexing `scenario.task` lets Cosmos evaluate the regex against index terms
 * instead of loading documents. Verified via `explain`: the search `$or` goes
 * from `pathsNotIndexed: ["scenario.task"]` + every document retrieved, to
 * `pathsNotIndexed: []` with `indexHitRatio: 1` and only matching documents
 * retrieved.
 *
 * `scenario.task` holds free-text prompt bodies (high-cardinality strings);
 * this is an intentional trade of some write-RU / index size for keeping the
 * task-text search server-side without a full scan.
 *
 * CosmosDB silently ignores indexes it cannot support, so validate with
 * `db.requests.getIndexes()` after applying.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddRunsSearchTaskIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");
    try {
      await col.createIndex({ "scenario.task": 1 });
      console.log("[023] Created index scenario.task_1 on requests");
    } catch (err: any) {
      console.log(
        `[023] Index scenario.task_1 already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(_db: Db): Promise<void> {
    console.log(
      "[023-down] Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
