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
 * Uses cursor-based batching to avoid CosmosDB 429 (RU exhaustion).
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const BATCH_SIZE = 50;
const INTER_BATCH_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(err: any): number {
  if (typeof err?.retryAfterMs === "number") return err.retryAfterMs;
  const match = String(err?.message ?? "").match(/RetryAfterMs=(\d+)/);
  if (match) return parseInt(match[1], 10);
  return 2000;
}

const MAX_RETRIES = 5;

export class AddPriorityAndSchedulerIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // 1. Backfill priority: 0 on all documents that don't have it
    console.log("[015] Backfilling priority: 0 on existing requests...");
    let totalUpdated = 0;
    let batchNum = 0;

    const cursor = requests.find(
      { priority: { $exists: false } },
      { projection: { _id: 1 } },
    );

    let batch: any[] = [];

    for await (const doc of cursor) {
      batch.push(doc._id);

      if (batch.length >= BATCH_SIZE) {
        batchNum++;
        const ids = [...batch];
        batch = [];

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const result = await requests.updateMany(
              { _id: { $in: ids } as any },
              { $set: { priority: 0 } },
            );
            totalUpdated += result.modifiedCount;
            break;
          } catch (err: any) {
            if (err?.code === 16500 || err?.code === 429) {
              const waitMs = getRetryAfterMs(err);
              console.warn(`[015] Batch ${batchNum} throttled, retrying in ${waitMs}ms...`);
              await sleep(waitMs);
            } else {
              throw err;
            }
          }
        }

        if (batchNum % 10 === 0) {
          console.log(`[015] Processed ${batchNum} batches (${totalUpdated} updated)`);
        }
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const result = await requests.updateMany(
            { _id: { $in: batch } as any },
            { $set: { priority: 0 } },
          );
          totalUpdated += result.modifiedCount;
          break;
        } catch (err: any) {
          if (err?.code === 16500 || err?.code === 429) {
            const waitMs = getRetryAfterMs(err);
            console.warn(`[015] Final batch throttled, retrying in ${waitMs}ms...`);
            await sleep(waitMs);
          } else {
            throw err;
          }
        }
      }
    }

    console.log(`[015] Backfilled priority on ${totalUpdated} documents`);

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
    let totalUpdated = 0;
    let batchNum = 0;

    const cursor = requests.find(
      { priority: { $exists: true } },
      { projection: { _id: 1 } },
    );

    let batch: any[] = [];

    for await (const doc of cursor) {
      batch.push(doc._id);

      if (batch.length >= BATCH_SIZE) {
        batchNum++;
        const ids = [...batch];
        batch = [];

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const result = await requests.updateMany(
              { _id: { $in: ids } as any },
              { $unset: { priority: "" } },
            );
            totalUpdated += result.modifiedCount;
            break;
          } catch (err: any) {
            if (err?.code === 16500 || err?.code === 429) {
              await sleep(getRetryAfterMs(err));
            } else {
              throw err;
            }
          }
        }
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }

    if (batch.length > 0) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const result = await requests.updateMany(
            { _id: { $in: batch } as any },
            { $unset: { priority: "" } },
          );
          totalUpdated += result.modifiedCount;
          break;
        } catch (err: any) {
          if (err?.code === 16500 || err?.code === 429) {
            await sleep(getRetryAfterMs(err));
          } else {
            throw err;
          }
        }
      }
    }

    console.log(`[015-down] Removed priority from ${totalUpdated} documents`);
  }
}
