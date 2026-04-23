// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: introduce per-attempt RunState embedded in requests + create
 * the `runs` collection (history-only) for the run-retry-attempts feature.
 *
 * See: growth-ecosystems/scope-core#658
 *
 * `up` reshapes every existing `requests` document so that per-attempt
 * mutable fields live under a nested `run` object (RunState shape).
 * The first attempt's `run._id` is set to the existing request `_id`
 * so artifact blob paths (`{runId}/iteration-N/...`) stay valid.
 *
 * Any in-flight requests (status `pending` or `processing`) are marked
 * as `done`+`failed` with an "abandoned during migration" error so users
 * can retry them via the new endpoint after deploy.
 *
 * Indexes on per-attempt fields (`status`, `outcome`) are recreated under
 * their new path (`run.status`, `run.outcome`).
 *
 * The new `runs` collection is created with indexes for:
 *   - `{ requestId: 1 }`                   — list attempts of a request
 *   - `{ requestId: 1, attemptNumber: -1 }` — ordered history
 */

import type { Db, Collection, Document, AnyBulkWriteOperation } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { RUN_FIELDS, buildRunReshapeUpdate, buildRunUnshapeUpdate } from "../014-helpers.js";

/** Cosmos DB 429 (TooManyRequests) error code. */
const COSMOS_429 = 16500;
const BATCH_SIZE = 25;
const INTER_BATCH_DELAY_MS = 100;
const MAX_RETRIES = 5;
const DEFAULT_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottleError(err: any): boolean {
  return err?.code === COSMOS_429 || err?.message?.includes("TooManyRequests");
}

function getRetryAfterMs(err: any): number {
  return err?.errorResponse?.RetryAfterMs ?? err?.retryAfterMs ?? DEFAULT_RETRY_MS;
}

async function executeBulkWithRetry(
  col: Collection,
  ops: AnyBulkWriteOperation[],
  label: string,
): Promise<number> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await col.bulkWrite(ops, { ordered: false });
      return res.modifiedCount;
    } catch (err: any) {
      if (isThrottleError(err) && attempt < MAX_RETRIES) {
        const retryMs = getRetryAfterMs(err);
        console.log(`  ${label}: 429 throttled, retrying in ${retryMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(retryMs);
        continue;
      }
      throw err;
    }
  }
  return 0; // unreachable
}

async function reshapeRequestsBatched(col: Collection, label: string): Promise<number> {
  let total = 0;
  let processed = 0;
  let batch: AnyBulkWriteOperation[] = [];

  const cursor = col.find(
    { run: { $exists: false } },
    {
      projection: { _id: 1, ...Object.fromEntries(RUN_FIELDS.map((f) => [f, 1])) },
      batchSize: 50,
    },
  );

  for await (const doc of cursor) {
    const { $set, $unset } = buildRunReshapeUpdate(doc as Document);
    batch.push({
      updateOne: {
        filter: { _id: doc._id, run: { $exists: false } },
        update: { $set, $unset },
      },
    });

    if (batch.length >= BATCH_SIZE) {
      total += await executeBulkWithRetry(col, batch, label);
      processed += batch.length;
      batch = [];
      if (processed % 100 === 0) {
        console.log(`  ${label}: processed ${processed}, modified ${total}`);
      }
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  // Flush remaining partial batch
  if (batch.length > 0) {
    total += await executeBulkWithRetry(col, batch, label);
    processed += batch.length;
  }

  console.log(`  ${label}: done — processed ${processed}, modified ${total}`);
  return total;
}

async function dropIndexIfExists(col: Collection, name: string): Promise<void> {
  try {
    await col.dropIndex(name);
    console.log(`  Dropped index ${name}`);
  } catch (err: any) {
    // index didn't exist — fine
    console.log(`  Index ${name} not present (skipped): ${err?.message ?? err}`);
  }
}

async function createIndexIfMissing(
  col: Collection,
  key: Record<string, 1 | -1>,
  name: string,
): Promise<void> {
  try {
    await col.createIndex(key);
    console.log(`  Created index ${name}`);
  } catch (err: any) {
    console.log(`  Index ${name} already exists or couldn't be created: ${err?.message ?? err}`);
  }
}

export class IntroduceRunsAndRun implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // 1. Reshape requests to nest per-attempt fields under `run`.
    await reshapeRequestsBatched(requests, "requests — nest per-attempt fields under run");

    // 2. Drop now-stale flat-field indexes on requests; create nested-path replacements.
    await dropIndexIfExists(requests, "status_1");
    await dropIndexIfExists(requests, "outcome_1");
    await createIndexIfMissing(requests, { "run.status": 1 }, "run.status_1");
    await createIndexIfMissing(requests, { "run.outcome": 1 }, "run.outcome_1");

    // 3. Create the `runs` collection (no-op if it already exists) and its indexes.
    try {
      await db.createCollection("runs");
      console.log("  Created collection runs");
    } catch (err: any) {
      // NamespaceExists (48) on Mongo, or generic "already exists" on Cosmos
      console.log(`  Collection runs already exists or couldn't be created: ${err?.message ?? err}`);
    }
    const runs = db.collection("runs");
    await createIndexIfMissing(runs, { requestId: 1 }, "requestId_1");
    await createIndexIfMissing(runs, { requestId: 1, attemptNumber: -1 }, "requestId_1_attemptNumber_-1");
  }

  async down(db: Db): Promise<void> {
    const requests = db.collection("requests");
    const label = "requests — lift run.* back to top level";

    // 1. Lift `run.*` back to the top level on each request (batched with retry).
    let total = 0;
    let processed = 0;
    let batch: AnyBulkWriteOperation[] = [];

    const cursor = requests.find({ run: { $exists: true } }, { batchSize: 50 });
    for await (const doc of cursor) {
      const { $set, $unset } = buildRunUnshapeUpdate(doc as Document);
      const update: Record<string, unknown> = { $unset };
      if (Object.keys($set).length > 0) update.$set = $set;
      batch.push({
        updateOne: {
          filter: { _id: doc._id, run: { $exists: true } },
          update,
        },
      });

      if (batch.length >= BATCH_SIZE) {
        total += await executeBulkWithRetry(requests, batch, label);
        processed += batch.length;
        batch = [];
        if (processed % 100 === 0) {
          console.log(`  ${label}: processed ${processed}, modified ${total}`);
        }
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }

    if (batch.length > 0) {
      total += await executeBulkWithRetry(requests, batch, label);
      processed += batch.length;
    }

    console.log(`  ${label}: done — processed ${processed}, modified ${total}`);

    // 2. Restore flat-field indexes; drop nested-path replacements.
    await dropIndexIfExists(requests, "run.status_1");
    await dropIndexIfExists(requests, "run.outcome_1");
    await createIndexIfMissing(requests, { status: 1 }, "status_1");
    await createIndexIfMissing(requests, { outcome: 1 }, "outcome_1");

    // 3. Drop the runs collection.
    try {
      await db.dropCollection("runs");
      console.log("  Dropped collection runs");
    } catch (err: any) {
      console.log(`  Collection runs not dropped: ${err?.message ?? err}`);
    }
  }
}
