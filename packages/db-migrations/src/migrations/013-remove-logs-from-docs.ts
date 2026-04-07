// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Remove embedded logs arrays from request and report documents.
 *
 * Logs are now stored as JSONL append blobs in Azure Blob Storage (container: "logs").
 * The `logs` field on request and report documents only consumed CosmosDB RUs
 * and contributed to rate-limit pressure.  This migration $unsets those arrays
 * to reclaim storage and reduce document size.
 *
 * Uses cursor-based batching to avoid CosmosDB 429 (RU exhaustion).
 */

import type { Db, Collection, ObjectId } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const BATCH_SIZE = 10;
const INTER_BATCH_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(err: any): number {
  if (typeof err?.retryAfterMs === "number") return err.retryAfterMs;
  const match = String(err?.message ?? "").match(/RetryAfterMs=(\d+)/);
  if (match) return parseInt(match[1], 10);
  return 2000;
}

async function batchUnset(
  col: Collection,
  label: string,
): Promise<number> {
  let total = 0;
  const ids: ObjectId[] = [];

  const cursor = col.find({ logs: { $exists: true } }, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    ids.push(doc._id);
  }

  if (ids.length === 0) {
    console.log(`  ${label}: 0 documents to update`);
    return 0;
  }

  console.log(`  ${label}: ${ids.length} documents in ${Math.ceil(ids.length / BATCH_SIZE)} batches`);

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    let retries = 0;
    const maxRetries = 10;

    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    while (retries < maxRetries) {
      try {
        const result = await col.updateMany(
          { _id: { $in: batch } },
          { $unset: { logs: "" } },
        );
        total += result.modifiedCount;
        break;
      } catch (err: any) {
        if (err?.code === 16500 && retries < maxRetries - 1) {
          const delay = Math.max(getRetryAfterMs(err), 500);
          console.log(`  ${label}: 429 batch ${Math.floor(i / BATCH_SIZE) + 1}, retry ${retries + 1}/${maxRetries - 1}, waiting ${delay}ms...`);
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

export class RemoveLogsFromDocs implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await batchUnset(db.collection("requests"), "requests — $unset logs");
    await batchUnset(db.collection("reports"), "reports — $unset logs");
  }

  async down(_db: Db): Promise<void> {
    // Intentionally a no-op: we cannot restore logs from blob storage in a down migration.
    // Re-adding an empty array would be misleading.
    console.log("down: no-op — logs cannot be restored from blob storage");
  }
}
