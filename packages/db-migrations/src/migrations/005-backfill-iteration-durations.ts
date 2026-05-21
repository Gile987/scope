// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill startedAt and durationMs on existing turns.
 *
 * For runs that already have turns with timestamps but no duration data,
 * this migration estimates durations from consecutive turn timestamps:
 *   - Turn 1: durationMs = turn[0].timestamp - request.createdAt
 *   - Turn N: durationMs = turn[N].timestamp - turn[N-1].timestamp
 *
 * These are estimates — the actual iteration time may differ from the
 * inter-timestamp gap. New runs will capture precise timing going forward.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class BackfillIterationDurations implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Find requests that have turns with timestamps but no durationMs yet
    const cursor = col.find({
      "turns.0": { $exists: true },
      "turns.durationMs": { $exists: false },
    });

    let updated = 0;
    let skipped = 0;

    for await (const doc of cursor) {
      const turns: any[] = doc.turns || [];
      if (turns.length === 0) {
        skipped++;
        continue;
      }

      const createdAt = doc.createdAt ? new Date(doc.createdAt).getTime() : null;
      const updates: Record<string, any> = {};
      let hasUpdate = false;

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const turnTimestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : null;

        if (!turnTimestamp) continue;

        const prevTimestamp = i === 0
          ? createdAt
          : (turns[i - 1].timestamp ? new Date(turns[i - 1].timestamp).getTime() : null);

        if (prevTimestamp != null) {
          const durationMs = Math.max(0, turnTimestamp - prevTimestamp);
          const startedAt = new Date(prevTimestamp);

          updates[`turns.${i}.durationMs`] = durationMs;
          updates[`turns.${i}.startedAt`] = startedAt;
          hasUpdate = true;
        }
      }

      if (hasUpdate) {
        await col.updateOne({ _id: doc._id }, { $set: updates });
        updated++;
      } else {
        skipped++;
      }
    }

    console.log(`  Backfilled iteration durations: ${updated} updated, ${skipped} skipped`);
  }

  async down(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Remove the backfilled fields
    await col.updateMany(
      { "turns.durationMs": { $exists: true } },
      { $unset: { "turns.$[].durationMs": "", "turns.$[].startedAt": "" } },
    );

    console.log("  Removed backfilled startedAt and durationMs from turns");
  }
}
