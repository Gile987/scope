// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for migration 014-introduce-runs-and-run.
 *
 * These live in a sibling file (outside `migrations/`) because
 * `mongo-migrate-ts` instantiates every exported function in a migration
 * file with `new` to discover migration classes. Helper functions co-located
 * with the migration class would crash that loader.
 */

import type { Document } from "mongodb";

/**
 * Field names whose values move from the top level of a `requests` document
 * into the new nested `run` object. Mirrors `RUN_STATE_FIELD_NAMES` in
 * `packages/shared/src/types/types.ts`.
 *
 * Note: `logs` is intentionally absent — it was removed from the document
 * model by migration 013-remove-logs-from-docs.
 */
export const RUN_FIELDS = [
  "status",
  "outcome",
  "result",
  "error",
  "updatedAt",
  "turns",
  "workerVersion",
  "os",
  "harUrl",
  "videoUrls",
  "setupVideoUrls",
  "tokenUsage",
  "aiCallCount",
  "rawChatUrl",
  "rawChatFormat",
] as const;

/**
 * Pure transform: build the `run` subdocument and `attemptCount` from a
 * legacy flat request document. Returns the updates required to reshape
 * the document, with separate `$set` and `$unset` operators.
 */
export function buildRunReshapeUpdate(doc: Document): {
  $set: Document;
  $unset: Document;
} {
  const run: Document = {
    _id: doc._id,
    attemptNumber: 1,
    status: doc.status ?? "done",
  };

  for (const field of RUN_FIELDS) {
    if (field === "status") continue;
    if (doc[field] === undefined) continue;
    run[field] = doc[field];
  }

  if (run.status === "pending" || run.status === "processing") {
    run.status = "done";
    run.outcome = "failed";
    run.error =
      "Abandoned during migration to attempts model — please retry.";
    run.finishedAt = new Date();
  }

  const $set: Document = { run, attemptCount: 1 };
  const $unset: Document = {};
  for (const field of RUN_FIELDS) {
    $unset[field] = "";
  }

  return { $set, $unset };
}

/**
 * Reverse of `buildRunReshapeUpdate` — for the `down` migration.
 * Lifts `run.*` fields back to the top level and drops `run` + `attemptCount`.
 */
export function buildRunUnshapeUpdate(doc: Document): {
  $set: Document;
  $unset: Document;
} {
  const $set: Document = {};
  const run: Document = doc.run ?? {};

  for (const field of RUN_FIELDS) {
    if (run[field] === undefined) continue;
    $set[field] = run[field];
  }

  return {
    $set,
    $unset: { run: "", attemptCount: "" },
  };
}
