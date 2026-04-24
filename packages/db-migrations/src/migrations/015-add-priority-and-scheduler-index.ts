// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add priority field to requests and create scheduler dispatch index.
 *
 * Supports the queue-priority-pause-resume feature:
 * 1. Backfill `priority: 0` on all existing request documents.
 * 2. Create a composite index for the scheduler's `findOneAndUpdate` dispatch
 *    query: { run.status, workerType, deletedAt, priority DESC, createdAt ASC }.
 *
 * Uses the shared batchUpdate helper for CosmosDB-safe batching with 429 retry.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class AddPriorityAndSchedulerIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // 1. Backfill priority: 0 on all documents that don't have it
    console.log("[015] Backfilling priority: 0 on existing requests...");
    await batchUpdate(
      requests,
      { priority: { $exists: false } },
      { $set: { priority: 0 } },
      "[015] backfill priority",
    );

    // 2. Create scheduler dispatch index
    console.log("[015] Creating idx_scheduler_dispatch index...");
    await requests.createIndex(
      {
        "run.status": 1,
        workerType: 1,
        deletedAt: 1,
        priority: -1,
        createdAt: 1,
      },
      { name: "idx_scheduler_dispatch" },
    );
    console.log("[015] Created idx_scheduler_dispatch index");
  }

  async down(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // Drop the scheduler index
    console.log("[015-down] Dropping idx_scheduler_dispatch index...");
    try {
      await requests.dropIndex("idx_scheduler_dispatch");
    } catch (err: any) {
      if (err?.codeName !== "IndexNotFound") throw err;
    }

    // Remove priority field from all documents
    console.log("[015-down] Removing priority field...");
    await batchUpdate(
      requests,
      { priority: { $exists: true } },
      { $unset: { priority: "" } },
      "[015-down] remove priority",
    );
  }
}
