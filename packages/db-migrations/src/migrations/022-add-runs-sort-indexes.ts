// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Server-side sorting support for the Runs list page (issue #1138).
 *
 * 1. Backfill the denormalized `run.durationMs` (= run.finishedAt −
 *    run.startedAt, in ms) on existing finished runs so they are immediately
 *    sortable by duration. Compute-on-write keeps it fresh going forward.
 * 2. Create 2-field compound indexes `{ <sortField>, _id }` — in BOTH
 *    directions — for every server-sortable column, per the Cosmos DB ORDER BY
 *    rule (a sort needs a direction-matching composite index of ≤2 fields;
 *    Cosmos does not reliably serve a descending ORDER BY from an ascending
 *    composite index — migration 010 created both directions for `createdAt`
 *    for the same reason).
 *
 *    `createdAt` (the default sort) already has both directions from
 *    migration 010, so it is intentionally omitted here.
 *
 * CosmosDB silently ignores compound indexes it cannot support, so validate
 * with `db.requests.getIndexes()` after applying.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

const SORT_FIELDS = [
  "updatedAt",
  "priority",
  "workerType",
  "run.status",
  "run.durationMs",
] as const;

export class AddRunsSortIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // 1. Backfill run.durationMs on finished runs that have both timestamps.
    //    Field-path-only aggregation pipeline (Cosmos-supported) so no app
    //    code needs to read the values back first.
    console.log("[022] Backfilling run.durationMs on finished runs...");
    await batchUpdate(
      requests,
      {
        "run.startedAt": { $exists: true, $ne: null },
        "run.finishedAt": { $exists: true, $ne: null },
        "run.durationMs": { $exists: false },
      },
      [
        {
          $set: {
            "run.durationMs": {
              $subtract: ["$run.finishedAt", "$run.startedAt"],
            },
          },
        },
      ] as unknown as Record<string, unknown>,
      "[022] backfill run.durationMs",
    );

    // 2. Compound sort indexes (both directions) for each sortable column.
    for (const field of SORT_FIELDS) {
      for (const dir of [1, -1] as const) {
        const key = { [field]: dir, _id: dir } as Record<string, 1 | -1>;
        const name = `${field}_${dir}__id_${dir}`;
        try {
          await requests.createIndex(key, { name });
          console.log(`[022] Created index ${name} on requests`);
        } catch (err: any) {
          console.log(
            `[022] Index ${name} already exists or couldn't be created: ${err.message ?? err}`,
          );
        }
      }
    }
  }

  async down(_db: Db): Promise<void> {
    console.log(
      "[022-down] Skipping index drop / durationMs unset — should be done manually if needed",
    );
  }
}
