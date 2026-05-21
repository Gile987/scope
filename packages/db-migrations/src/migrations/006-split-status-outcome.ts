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

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

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
