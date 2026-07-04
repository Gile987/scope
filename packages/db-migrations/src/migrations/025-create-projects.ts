// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Data Organization — Projects (#1210).
 *
 * Introduces the first-class `projects` container and files every existing
 * scoped document into **one ordinary initial project**. Behaviour-preserving:
 * post-migration all existing data sits in that single project, so today's
 * listings are unchanged (just scoped to it).
 *
 * There is **no Default project and no `isDefault` flag** — the initial project
 * is a normal, re-nameable project. It is simply the oldest one, which is how
 * this migration re-locates it on re-run (idempotency).
 *
 * Steps (up):
 *   1. Create the `projects` collection + its indexes.
 *   2. Insert exactly one initial project (fresh UUID `_id`), or reuse the
 *      existing oldest project on re-run.
 *   3. Backfill `projectId = <initialId>` on every scoped collection (RU-paced).
 *   4. Deterministic-key entities:
 *        - task-prompts: backfill `keyId = _id` (legacy `_id` is already the
 *          content-address `computePromptId(type,text)`, so `keyId === _id`).
 *        - skill-revisions: `ref` already present — nothing to backfill.
 *      Then swap unique indexes:
 *        - skill-revisions `{ref}` → `{projectId, ref}` (unique).
 *        - task-prompts add unique `{projectId, keyId}`.
 *      A pre-assert guards against pre-existing composite-key collisions (which
 *      would make unique-index creation fail on real MongoDB).
 *
 *      **Cosmos DB caveat (RU-based):** a unique index can only be created while
 *      the collection is empty / at creation time (via the CreateCollection
 *      extension command). `createIndex(..., {unique:true})` on a *populated*
 *      collection fails with code 67 (`CannotCreateIndex`). We therefore degrade
 *      gracefully: on code 67 we create a **non-unique** index on the same key
 *      (kept for lookup performance) and rely on the application-level
 *      `findOrCreate` for per-project dedup — which is already how these
 *      collections behave on Cosmos today (migration 003's unique `{ref}` index
 *      silently no-op'd there). Real MongoDB (local/CI) still gets true unique
 *      indexes, so unit/integration tests continue to assert uniqueness.
 *   5. Add scoping indexes `{projectId}` and `{projectId, _id}` on every scoped
 *      collection (supports the required `?projectId=` list filter).
 *
 * down(): unset `projectId` (all scoped) + `keyId` (task-prompts); index changes
 * are log-only (drop manually if needed), matching the repo convention.
 */

import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import {
  BATCH_SIZE,
  INTER_BATCH_DELAY_MS,
  batchUpdate,
  getRetryAfterMs,
  sleep,
} from "../batch-update.js";

/** Every scoped collection that receives a `projectId`. Source: A0 map. */
const SCOPED_COLLECTIONS = [
  // ROOT (projectId from ?projectId= at create)
  "requests",
  "profiles",
  "criteria",
  "prompt-features",
  "mcp-servers",
  "report-templates",
  "skills",
  "extensions",
  "codebases",
  // CHILD (projectId copied from a parent)
  "runs",
  "profile-versions",
  "codebase-revisions",
  "reports",
  "insights",
  // SPECIAL / A4 (per-project copies)
  "task-prompts",
  "skill-revisions",
] as const;

const DEFAULT_INITIAL_PROJECT_NAME = "Initial Project";

/** Index-already-exists error codes (Mongo + Cosmos MongoDB API). */
const ALREADY_EXISTS_CODES = new Set([85, 86, 68]);
/** Index/namespace-not-found error codes. */
const NOT_FOUND_CODES = new Set([26, 27]);
/**
 * Azure Cosmos DB (RU-based) rejects unique-index creation on a *populated*
 * collection with code 67 (`CannotCreateIndex`, "Cannot create unique index
 * when collection contains documents"). Real MongoDB has no such restriction.
 */
const CANNOT_CREATE_UNIQUE_ON_POPULATED = 67;

/** Create an index, tolerating "already exists" but surfacing real failures. */
async function ensureIndex(
  col: Collection,
  key: Record<string, 1 | -1>,
  options: { unique?: boolean } = {},
  label = "",
): Promise<void> {
  try {
    const name = await col.createIndex(key, options);
    console.log(`  [025] created index ${name} ${JSON.stringify(key)} on ${label}`);
  } catch (err: any) {
    if (ALREADY_EXISTS_CODES.has(err?.code)) {
      console.log(`  [025] index ${JSON.stringify(key)} on ${label} already exists`);
      return;
    }
    throw err;
  }
}

/** Drop an index by key spec, tolerating "not found". Best-effort. */
async function dropIndexSafe(
  col: Collection,
  key: Record<string, 1 | -1>,
  label = "",
): Promise<void> {
  try {
    await col.dropIndex(key as any);
    console.log(`  [025] dropped index ${JSON.stringify(key)} on ${label}`);
  } catch (err: any) {
    if (NOT_FOUND_CODES.has(err?.code)) {
      console.log(`  [025] index ${JSON.stringify(key)} on ${label} not present (skip drop)`);
      return;
    }
    console.log(
      `  [025] could not drop index ${JSON.stringify(key)} on ${label}: ${err?.message ?? err}`,
    );
  }
}

/**
 * Create a UNIQUE index, degrading gracefully on Azure Cosmos DB for MongoDB.
 *
 * On real MongoDB the unique index is created and enforced. On Cosmos (RU-based)
 * a unique index can only be created while the collection is empty / at creation
 * time (via the CreateCollection extension command), so `createIndex(...,
 * {unique:true})` on a *populated* collection fails with code 67. In that case we
 * fall back to a **non-unique** index on the same key (kept for lookup
 * performance) and rely on the application-level `findOrCreate` for per-project
 * dedup — which is already how these collections have always behaved on Cosmos
 * (migration 003's unique `{ref}` index silently no-op'd there). A pre-flight
 * `assertNoCompositeDuplicates` guards data quality regardless of backend, and
 * genuine duplicate-key errors (code 11000, real MongoDB) are surfaced, not
 * swallowed.
 */
async function ensureUniqueIndexOrFallback(
  col: Collection,
  key: Record<string, 1 | -1>,
  label: string,
): Promise<void> {
  try {
    const name = await col.createIndex(key, { unique: true });
    console.log(`  [025] created UNIQUE index ${name} ${JSON.stringify(key)} on ${label}`);
    return;
  } catch (err: any) {
    if (ALREADY_EXISTS_CODES.has(err?.code)) {
      console.log(`  [025] unique index ${JSON.stringify(key)} on ${label} already exists`);
      return;
    }
    if (err?.code !== CANNOT_CREATE_UNIQUE_ON_POPULATED) {
      throw err;
    }
    console.warn(
      `  [025] ⚠ ${label}: Cosmos DB cannot create a unique index on a populated ` +
        `collection (code 67). Falling back to a NON-unique ${JSON.stringify(key)} ` +
        `index; per-project uniqueness is enforced by the application (findOrCreate).`,
    );
  }
  // Fallback path (Cosmos): create the same key as a non-unique lookup index.
  await ensureIndex(col, key, {}, label);
}

/**
 * Throw if any composite key `fields` occurs more than once — a pre-existing
 * collision would make a unique index on those fields fail to build (esp. on
 * Cosmos). Called before creating `{projectId,ref}` / `{projectId,keyId}`.
 */
async function assertNoCompositeDuplicates(
  col: Collection,
  fields: string[],
  label: string,
): Promise<void> {
  const groupId: Record<string, string> = {};
  for (const f of fields) groupId[f] = `$${f}`;
  const dups = await col
    .aggregate([
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();
  if (dups.length > 0) {
    throw new Error(
      `[025] ${label}: found a duplicate ${JSON.stringify(fields)} — resolve before creating the unique index`,
    );
  }
}

/**
 * Copy each document's `_id` into a new `keyId` field, RU-paced and 429-retrying.
 * Only touches rows where `keyId` is absent (idempotent).
 */
async function backfillKeyIdFromId(col: Collection, label: string): Promise<number> {
  const ids: unknown[] = [];
  const cursor = col.find({ keyId: { $exists: false } }, { projection: { _id: 1 } });
  for await (const doc of cursor) ids.push(doc._id);

  if (ids.length === 0) {
    console.log(`  ${label}: 0 documents`);
    return 0;
  }
  console.log(
    `  ${label}: ${ids.length} documents in ${Math.ceil(ids.length / BATCH_SIZE)} batches`,
  );

  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    let retries = 0;
    const maxRetries = 10;
    while (retries < maxRetries) {
      try {
        const result = await col.bulkWrite(
          batch.map((id) => ({
            updateOne: { filter: { _id: id as any }, update: { $set: { keyId: id } } },
          })),
        );
        total += result.modifiedCount ?? 0;
        break;
      } catch (err: any) {
        if (err?.code === 16500 && retries < maxRetries - 1) {
          const delay = Math.max(getRetryAfterMs(err), 500);
          console.log(`  ${label}: 429, retry ${retries + 1}, waiting ${delay}ms...`);
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

export class CreateProjects implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const projects = db.collection("projects");

    // 1. projects collection + indexes (createIndex auto-creates the collection).
    await ensureIndex(projects, { createdAt: -1 }, {}, "projects");
    await ensureIndex(projects, { deletedAt: 1 }, {}, "projects");

    // 2. One initial project. Reuse the oldest on re-run (idempotent) — the
    //    initial project is always the oldest, since the migration creates it
    //    before any user-made project can exist.
    let initial = await projects.findOne({}, { sort: { createdAt: 1 } });
    if (!initial) {
      const now = new Date();
      const doc = {
        _id: randomUUID(),
        name: process.env.SCOPE_INITIAL_PROJECT_NAME || DEFAULT_INITIAL_PROJECT_NAME,
        createdAt: now,
      };
      await projects.insertOne(doc as any);
      initial = doc as any;
      console.log(`  [025] inserted initial project "${doc.name}" (${doc._id})`);
    } else {
      console.log(`  [025] reusing existing initial project (${initial._id})`);
    }
    const initialId = initial!._id as unknown as string;

    // 3. Backfill projectId on every scoped collection (only where missing).
    for (const name of SCOPED_COLLECTIONS) {
      await batchUpdate(
        db.collection(name),
        { projectId: { $exists: false } },
        { $set: { projectId: initialId } },
        `[025] backfill ${name}.projectId`,
      );
    }

    // 4. Deterministic-key entities.
    // 4a. task-prompts keyId = _id (legacy _id is already the content-address).
    await backfillKeyIdFromId(db.collection("task-prompts"), "[025] task-prompts.keyId=_id");

    // 4b. Unique-index swaps (guard against pre-existing collisions first).
    const skillRevisions = db.collection("skill-revisions");
    await assertNoCompositeDuplicates(skillRevisions, ["projectId", "ref"], "skill-revisions");
    await dropIndexSafe(skillRevisions, { ref: 1 }, "skill-revisions");
    await ensureUniqueIndexOrFallback(skillRevisions, { projectId: 1, ref: 1 }, "skill-revisions");

    const taskPrompts = db.collection("task-prompts");
    await assertNoCompositeDuplicates(taskPrompts, ["projectId", "keyId"], "task-prompts");
    await ensureUniqueIndexOrFallback(taskPrompts, { projectId: 1, keyId: 1 }, "task-prompts");

    // 5. Scoping indexes on every scoped collection.
    for (const name of SCOPED_COLLECTIONS) {
      const col = db.collection(name);
      await ensureIndex(col, { projectId: 1 }, {}, name);
      await ensureIndex(col, { projectId: 1, _id: 1 }, {}, name);
    }

    console.log(`[025] Projects migration complete — initial project ${initialId}`);
  }

  async down(db: Db): Promise<void> {
    // Reverse the field backfills; index changes are log-only per convention.
    for (const name of SCOPED_COLLECTIONS) {
      await batchUpdate(
        db.collection(name),
        { projectId: { $exists: true } },
        { $unset: { projectId: "" } },
        `[025-down] unset ${name}.projectId`,
      );
    }
    await batchUpdate(
      db.collection("task-prompts"),
      { keyId: { $exists: true } },
      { $unset: { keyId: "" } },
      "[025-down] unset task-prompts.keyId",
    );
    console.log(
      "  [025-down] Skipping index drops and initial-project removal — remove manually if needed",
    );
  }
}
