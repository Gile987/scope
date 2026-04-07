// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Split run status into status + outcome.
 *
 * The old status field conflated operational lifecycle and evaluation results:
 *   pending | processing | iterating | completed | failed | exhausted
 *
 * New model:
 *   status:  pending | processing | done
 *   outcome: succeeded | failed | exhausted  (only when status === "done")
 *
 * Mapping:
 *   iterating → status: "processing"  (no outcome — still in-flight)
 *   completed → status: "done", outcome: "succeeded"
 *   failed    → status: "done", outcome: "failed"
 *   exhausted → status: "done", outcome: "exhausted"
 *
 * "pending" and "processing" are unchanged.
 *
 * Uses cursor-based batching to avoid CosmosDB 429 (RU exhaustion) on large collections.
 */

import type { Db, Collection, ObjectId } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const BATCH_SIZE = 10;
const INTER_BATCH_DELAY_MS = 500;

/** Sleep helper for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract RetryAfterMs from a CosmosDB error (may be a property or in the message string). */
function getRetryAfterMs(err: any): number {
  if (typeof err?.retryAfterMs === "number") return err.retryAfterMs;
  const match = String(err?.message ?? "").match(/RetryAfterMs=(\d+)/);
  if (match) return parseInt(match[1], 10);
  return 2000;
}

/**
 * Update documents matching `filter` in batches, applying `update` to each batch.
 * Retries on CosmosDB 429 (error code 16500) with the server-suggested delay.
 */
async function batchUpdate(
  col: Collection,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  label: string,
): Promise<number> {
  let total = 0;
  const ids: ObjectId[] = [];

  // Collect matching _id values first (lightweight projection)
  const cursor = col.find(filter, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    ids.push(doc._id);
  }

  if (ids.length === 0) {
    console.log(`  ${label}: 0 documents`);
    return 0;
  }

  console.log(`  ${label}: ${ids.length} documents to process in ${Math.ceil(ids.length / BATCH_SIZE)} batches`);

  // Process in batches
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    let retries = 0;
    const maxRetries = 10;

    // Pace batches to avoid saturating RUs
    if (i > 0) {
      await sleep(INTER_BATCH_DELAY_MS);
    }

    while (retries < maxRetries) {
      try {
        const result = await col.updateMany({ _id: { $in: batch } }, update);
        total += result.modifiedCount;
        break;
      } catch (err: any) {
        // CosmosDB 429: error code 16500
        if (err?.code === 16500 && retries < maxRetries - 1) {
          const delay = Math.max(getRetryAfterMs(err), 500);
          console.log(`  ${label}: 429 on batch ${Math.floor(i / BATCH_SIZE) + 1}, retry ${retries + 1}/${maxRetries - 1}, waiting ${delay}ms...`);
          await sleep(delay);
          retries++;
        } else {
          throw err;
        }
      }
    }
  }

  console.log(`  ${label}: ${total} documents updated`);
  return total;
}

export class SplitStatusOutcome implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    // 1. iterating → processing (still in-flight, no outcome)
    await batchUpdate(
      col,
      { status: "iterating" },
      { $set: { status: "processing" } },
      "iterating → processing",
    );

    // 2. completed → done + succeeded
    await batchUpdate(
      col,
      { status: "completed" },
      { $set: { status: "done", outcome: "succeeded" } },
      "completed → done/succeeded",
    );

    // 3. failed → done + failed
    await batchUpdate(
      col,
      { status: "failed" },
      { $set: { status: "done", outcome: "failed" } },
      "failed → done/failed",
    );

    // 4. exhausted → done + exhausted
    await batchUpdate(
      col,
      { status: "exhausted" },
      { $set: { status: "done", outcome: "exhausted" } },
      "exhausted → done/exhausted",
    );
  }

  async down(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Reverse: done + outcome → old terminal status
    await batchUpdate(
      col,
      { status: "done", outcome: "succeeded" },
      { $set: { status: "completed" }, $unset: { outcome: "" } },
      "done/succeeded → completed",
    );

    await batchUpdate(
      col,
      { status: "done", outcome: "failed" },
      { $set: { status: "failed" }, $unset: { outcome: "" } },
      "done/failed → failed",
    );

    await batchUpdate(
      col,
      { status: "done", outcome: "exhausted" },
      { $set: { status: "exhausted" }, $unset: { outcome: "" } },
      "done/exhausted → exhausted",
    );

    // Note: "processing" stays as-is — we can't reliably distinguish which
    // ones were previously "iterating" vs. originally "processing".
  }
}
