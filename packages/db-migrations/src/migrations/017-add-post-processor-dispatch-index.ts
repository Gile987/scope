// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add post-processor dispatcher index.
 *
 * The PostProcessorDispatcher polls every 2s for completed runs that need
 * post-processing. Its query filters on:
 *   - run.status = "done"
 *   - run.postProcessorStatus NOT IN ["queued", "processing"]
 *   - deletedAt does not exist
 * And sorts by updatedAt DESC.
 *
 * Cosmos DB handles multi-property equality filters via index intersection on
 * single-field indexes (run.status, deletedAt — from migration 014). For the
 * ORDER BY + the key selectivity filter (postProcessorStatus), we create a
 * 2-field compound index on the sort field and the most selective filter.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddPostProcessorDispatchIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // Compound index: postProcessorStatus for filtering + updatedAt for sort
    try {
      await requests.createIndex(
        { "run.postProcessorStatus": 1 as const, updatedAt: -1 as const },
        { name: "idx_post_processor_dispatch" },
      );
      console.log("[017] Created idx_post_processor_dispatch index on requests");
    } catch (err: any) {
      console.log(
        `[017] idx_post_processor_dispatch already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    const requests = db.collection("requests");

    try {
      await requests.dropIndex("idx_post_processor_dispatch");
      console.log("[017-down] Dropped idx_post_processor_dispatch index");
    } catch (err: any) {
      if (err?.codeName !== "IndexNotFound") {
        console.log(`[017-down] idx_post_processor_dispatch not found: ${err.message ?? err}`);
      }
    }
  }
}
