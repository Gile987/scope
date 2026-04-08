// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill os field on existing completed runs.
 *
 * All historical production runs were processed by Docker containers on AKS
 * (Linux x64), so we can confidently set `os.platform = "linux"` on every
 * completed run that doesn't already have an `os` field.
 *
 * We leave `release` and `arch` unset — we know the platform but not the
 * exact kernel version or node pool architecture at the time each run executed.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const BATCH_SIZE = 500;
const INTER_BATCH_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BackfillWorkerOs implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Only backfill completed runs that don't already have an os field
    const filter = {
      status: "done",
      os: { $exists: false },
    };

    const total = await col.countDocuments(filter);
    console.log(`  Found ${total} completed runs without os field`);

    if (total === 0) return;

    let updated = 0;
    const cursor = col.find(filter, { projection: { _id: 1 } }).batchSize(BATCH_SIZE);
    let batch: any[] = [];

    for await (const doc of cursor) {
      batch.push(doc._id);

      if (batch.length >= BATCH_SIZE) {
        const result = await col.updateMany(
          { _id: { $in: batch } },
          { $set: { os: { platform: "linux" } } },
        );
        updated += result.modifiedCount;
        console.log(`  Backfilled ${updated}/${total} runs`);
        batch = [];
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }

    // Final partial batch
    if (batch.length > 0) {
      const result = await col.updateMany(
        { _id: { $in: batch } },
        { $set: { os: { platform: "linux" } } },
      );
      updated += result.modifiedCount;
    }

    console.log(`  Backfill complete: ${updated} runs updated with os.platform = "linux"`);
  }

  async down(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Remove the backfilled os field (only where it was set to exactly { platform: "linux" }
    // with no release/arch — i.e. the backfilled ones, not newly captured ones)
    const filter = {
      "os.platform": "linux",
      "os.release": { $exists: false },
      "os.arch": { $exists: false },
    };

    const result = await col.updateMany(filter, { $unset: { os: "" } });
    console.log(`  Removed backfilled os from ${result.modifiedCount} runs`);
  }
}
