// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Rename outcome "exhausted" → "finished".
 *
 * The "exhausted" label was misleading for single-shot runs — it implied
 * something went wrong when in reality the run simply used all its allotted
 * iterations without passing every criterion.  "finished" is neutral and
 * correctly conveys that the run completed its iteration budget.
 *
 * Uses the shared batchUpdate utility to respect CosmosDB RU rate limits.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class RenameExhaustedToFinished implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    await batchUpdate(
      col,
      { outcome: "exhausted" },
      { $set: { outcome: "finished" } },
      "exhausted → finished",
    );
  }

  async down(db: Db): Promise<void> {
    const col = db.collection("requests");

    await batchUpdate(
      col,
      { outcome: "finished" },
      { $set: { outcome: "exhausted" } },
      "finished → exhausted",
    );
  }
}
