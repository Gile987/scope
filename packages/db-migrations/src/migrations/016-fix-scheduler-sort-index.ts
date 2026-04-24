// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Replace the 5-field compound index with a simpler 2-field sort
 * index for the scheduler dispatch query.
 *
 * Cosmos DB for MongoDB (RU-based) silently dropped the 5-field compound index
 * created by migration 015 (`idx_scheduler_dispatch`). The resulting error:
 *
 *   "The order by query does not have a corresponding composite index
 *    that it can be served from."
 *
 * Cosmos DB handles multi-property filters via index intersection on existing
 * single-field indexes (run.status, workerType, deletedAt — from migration
 * 009). For the ORDER BY, a dedicated 2-field compound index on the sort
 * fields works reliably (same pattern as migration 010's pagination indexes).
 *
 * Also creates the reversed variant so the index can serve both sort
 * directions if needed in the future.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class FixSchedulerSortIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // Drop the broken 5-field compound index if it somehow exists
    try {
      await requests.dropIndex("idx_scheduler_dispatch");
      console.log("[016] Dropped old idx_scheduler_dispatch index");
    } catch (err: any) {
      if (err?.codeName !== "IndexNotFound") {
        console.log(`[016] idx_scheduler_dispatch not found (expected): ${err.message ?? err}`);
      }
    }

    // Create 2-field sort index: priority DESC, createdAt ASC
    const indexes = [
      { key: { priority: -1 as const, createdAt: 1 as const }, name: "priority_-1_createdAt_1" },
      { key: { priority: 1 as const, createdAt: -1 as const }, name: "priority_1_createdAt_-1" },
    ];

    for (const { key, name } of indexes) {
      try {
        await requests.createIndex(key);
        console.log(`[016] Created index ${name} on requests`);
      } catch (err: any) {
        console.log(
          `[016] Index ${name} already exists or couldn't be created: ${err.message ?? err}`,
        );
      }
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "[016-down] Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
