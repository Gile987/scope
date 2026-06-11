// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill criteria gate compatibility.
 *
 * The Gates feature (issue #97) introduces a `gates` field on criteria that
 * declares which pipeline gates (select, build, test, run, deploy) a criterion
 * is compatible with. To preserve existing behaviour — where every criterion is
 * evaluated in the single (Select) pass — we backfill existing criteria that
 * lack a `gates` field with `["select"]`.
 *
 * Criteria with an absent `gates` field are otherwise treated as compatible
 * with all gates by the runtime, which would change behaviour for legacy
 * criteria, so this explicit backfill keeps them Select-only.
 *
 * down() reverses only the rows this migration set to exactly ["select"],
 * unsetting the field to restore the pre-migration state.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class BackfillCriteriaGates implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const criteria = db.collection("criteria");

    const count = await batchUpdate(
      criteria,
      { gates: { $exists: false } },
      { $set: { gates: ["select"] } },
      "[018] backfill criteria.gates=[select]",
    );

    console.log(`[018] Backfilled gates=[select] on ${count} criteria`);
  }

  async down(db: Db): Promise<void> {
    const criteria = db.collection("criteria");

    const count = await batchUpdate(
      criteria,
      { gates: ["select"] },
      { $unset: { gates: "" } },
      "[018-down] unset criteria.gates",
    );

    console.log(`[018-down] Unset gates on ${count} criteria`);
  }
}
