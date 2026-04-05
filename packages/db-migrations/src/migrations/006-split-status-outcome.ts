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
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class SplitStatusOutcome implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    // 1. iterating → processing (still in-flight, no outcome)
    const r1 = await col.updateMany(
      { status: "iterating" },
      { $set: { status: "processing" } },
    );
    console.log(`iterating → processing: ${r1.modifiedCount} documents`);

    // 2. completed → done + succeeded
    const r2 = await col.updateMany(
      { status: "completed" },
      { $set: { status: "done", outcome: "succeeded" } },
    );
    console.log(`completed → done/succeeded: ${r2.modifiedCount} documents`);

    // 3. failed → done + failed
    const r3 = await col.updateMany(
      { status: "failed" },
      { $set: { status: "done", outcome: "failed" } },
    );
    console.log(`failed → done/failed: ${r3.modifiedCount} documents`);

    // 4. exhausted → done + exhausted
    const r4 = await col.updateMany(
      { status: "exhausted" },
      { $set: { status: "done", outcome: "exhausted" } },
    );
    console.log(`exhausted → done/exhausted: ${r4.modifiedCount} documents`);
  }

  async down(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Reverse: done + outcome → old terminal status
    const r1 = await col.updateMany(
      { status: "done", outcome: "succeeded" },
      { $set: { status: "completed" }, $unset: { outcome: "" } },
    );
    console.log(`done/succeeded → completed: ${r1.modifiedCount} documents`);

    const r2 = await col.updateMany(
      { status: "done", outcome: "failed" },
      { $set: { status: "failed" }, $unset: { outcome: "" } },
    );
    console.log(`done/failed → failed: ${r2.modifiedCount} documents`);

    const r3 = await col.updateMany(
      { status: "done", outcome: "exhausted" },
      { $set: { status: "exhausted" }, $unset: { outcome: "" } },
    );
    console.log(`done/exhausted → exhausted: ${r3.modifiedCount} documents`);

    // Note: "processing" stays as-is — we can't reliably distinguish which
    // ones were previously "iterating" vs. originally "processing".
  }
}
