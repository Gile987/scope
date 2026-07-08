// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill task-prompt type discriminator.
 *
 * The Gates feature (issue #97) generalises task prompts into typed gate
 * prompts via a `type` field — one literal per gate (select, build, test, run,
 * deploy). Every existing task prompt is the Select gate's prompt (the request
 * task), so we backfill `type: "select"` where the field is absent.
 *
 * This is a FIELD-ONLY backfill: the `_id` (content-addressed UUIDv5 of the
 * trimmed text) is intentionally left untouched so that every request, profile
 * and report already referencing a `taskPromptId` stays valid. Select prompts
 * are hashed from text alone, so their ids are unchanged by typing.
 *
 * down() unsets `type` only on rows this migration set to exactly "select".
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class BackfillTaskPromptType implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const taskPrompts = db.collection("task-prompts");

    const count = await batchUpdate(
      taskPrompts,
      { type: { $exists: false } },
      { $set: { type: "select" } },
      "[019] backfill task-prompts.type=select",
    );

    console.log(`[019] Backfilled type=select on ${count} task prompts`);
  }

  async down(db: Db): Promise<void> {
    const taskPrompts = db.collection("task-prompts");

    const count = await batchUpdate(
      taskPrompts,
      { type: "select" },
      { $unset: { type: "" } },
      "[019-down] unset task-prompts.type",
    );

    console.log(`[019-down] Unset type on ${count} task prompts`);
  }
}
