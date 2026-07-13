// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Pure helpers for server-side Runs-list filtering and sorting
 * (GET /api/v1/requests). Kept separate from the route handler so the
 * multi-value / `(Unknown)` sentinel / regex-search / cursor-seek logic can be
 * unit-tested in isolation (see run-query.test.ts).
 *
 * These power issue #1138 — moving *all* filter, sort, and grouping evaluation
 * off the client and onto the API so it composes with cursor pagination.
 *
 * Sort-by-duration relies on a denormalized `run.durationMs` (finishedAt −
 * startedAt); unfinished runs leave it unset and sort null-last (see buildSeek).
 */

import { EMPTY_FILTER_VALUE } from "shared";

/** Allowlist mapping the API `sortBy` token → an indexable stored field. */
export const SORT_FIELD_MAP: Record<string, string> = {
  created: "createdAt",
  createdAt: "createdAt", // legacy alias (sortBy used to be createdAt|priority)
  updated: "updatedAt",
  priority: "priority",
  worker: "workerType",
  status: "run.status",
  id: "_id",
  duration: "run.durationMs",
};

/** Sort fields stored as Dates (cursor values serialize to ISO strings). */
export const DATE_SORT_FIELDS = new Set(["createdAt", "updatedAt"]);
/** Sort fields stored as numbers (cursor values serialize to numeric strings). */
export const NUMERIC_SORT_FIELDS = new Set(["priority", "run.durationMs"]);

/** Resolve a `sortBy` token to its stored field, defaulting to `createdAt`. */
export function resolveSortField(sortBy: string | undefined): string {
  return (sortBy && SORT_FIELD_MAP[sortBy]) || "createdAt";
}

/**
 * Parse a categorical filter param into a list of trimmed, non-empty tokens.
 * Accepts a single value, a repeated param (Express array), or a comma-
 * separated string — so `?status=a&status=b` and `?status=a,b` are equivalent.
 */
export function parseMulti(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "number") {
      out.push(String(item));
      continue;
    }
    if (typeof item !== "string") continue;
    for (const part of item.split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Build a single AND-clause for a categorical dimension supporting multi-value
 * selection plus the `__empty__` ("(Unknown)") sentinel, which matches rows
 * missing the field. Returns `null` when nothing is selected.
 */
export function buildMultiClause(
  field: string,
  values: string[],
  opts?: { coerceNumber?: boolean },
): Record<string, unknown> | null {
  if (values.length === 0) return null;
  const wantEmpty = values.includes(EMPTY_FILTER_VALUE);
  let concrete: unknown[] = values.filter((v) => v !== EMPTY_FILTER_VALUE);
  if (opts?.coerceNumber) {
    concrete = (concrete as string[]).map((v) => Number(v)).filter((n) => Number.isFinite(n));
  }

  // Single concrete value, no sentinel → plain equality (cheapest, index-friendly).
  if (concrete.length === 1 && !wantEmpty) {
    return { [field]: concrete[0] };
  }

  const ors: Record<string, unknown>[] = [];
  if (concrete.length > 0) ors.push({ [field]: { $in: concrete } });
  if (wantEmpty) {
    ors.push({ [field]: { $exists: false } });
    ors.push({ [field]: null });
  }
  if (ors.length === 0) return null;
  if (ors.length === 1) return ors[0];
  return { $or: ors };
}

/**
 * Build a case-insensitive regex `$or` clause matching `term` across the run
 * id, scenario task, model, and worker. Cosmos DB has no `$text` index, so we
 * use anchored-free regex. Returns `null` for an empty term.
 */
export function buildSearchClause(term: string | undefined): Record<string, unknown> | null {
  const t = (term ?? "").trim();
  if (!t) return null;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = { $regex: escaped, $options: "i" };
  return {
    $or: [
      { _id: rx },
      { taskPromptId: rx },
      { "scenario.task": rx },
      { model: rx },
      { workerType: rx },
    ],
  };
}

/** Extract a document's value for a given sort field. */
export function sortValueOf(doc: Record<string, any> | undefined, field: string): unknown {
  if (!doc) return undefined;
  switch (field) {
    case "createdAt": return doc.createdAt;
    case "updatedAt": return doc.updatedAt;
    case "priority": return doc.priority;
    case "workerType": return doc.workerType;
    case "run.status": return doc.run?.status;
    case "run.durationMs": return doc.run?.durationMs;
    case "_id": return doc._id;
    default: return doc.createdAt;
  }
}

/** Serialize a sort value for inclusion in a cursor. Null/missing → "". */
export function serializeSortValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (DATE_SORT_FIELDS.has(field)) {
    const d = value instanceof Date ? value : new Date(value as string);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return String(value);
}

/** Inverse of {@link serializeSortValue}. Empty string → null. */
export function deserializeSortValue(field: string, raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return null;
  if (DATE_SORT_FIELDS.has(field)) return new Date(raw);
  if (NUMERIC_SORT_FIELDS.has(field)) return Number(raw);
  return raw;
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

/**
 * Build a seek predicate selecting documents strictly *after* the cursor
 * document `(cval, cid)` in the sort order `{ [field]: qdir, _id: qdir }`.
 *
 * Correctly places null/missing sort values, which Mongo/Cosmos order *first*
 * in ascending and *last* in descending — so cursoring never skips or
 * duplicates rows whose sort field is unset (e.g. `run.durationMs` on
 * unfinished runs, or `run.status` on runs with no attempt yet).
 */
export function buildSeek(
  field: string,
  qdir: 1 | -1,
  cval: unknown,
  cid: string,
): Record<string, unknown> {
  const cmp = qdir === 1 ? "$gt" : "$lt";
  if (field === "_id") {
    return { _id: { [cmp]: cid } };
  }
  const missing = { $or: [{ [field]: null }, { [field]: { $exists: false } }] };
  const ors: Record<string, unknown>[] = [];
  if (isNullish(cval)) {
    // Cursor sits in the null block: tiebreak among null/missing rows by _id.
    ors.push({ $and: [missing, { _id: { [cmp]: cid } }] });
    if (qdir === 1) {
      // Ascending: every non-null row sorts *after* the null block.
      ors.push({ [field]: { $exists: true, $ne: null } });
    }
    // Descending: nulls sort last, so nothing follows except the tiebreaker.
  } else {
    ors.push({ [field]: { [cmp]: cval } });
    ors.push({ [field]: cval, _id: { [cmp]: cid } });
    if (qdir === -1) {
      // Descending: null/missing rows sort *after* all non-null values.
      ors.push(missing);
    }
  }
  return ors.length === 1 ? ors[0] : { $or: ors };
}

/** Build a `{ [field]: dir, _id: dir }` sort object (omits the tiebreaker for `_id`). */
export function buildSortObject(field: string, dir: 1 | -1): Record<string, 1 | -1> {
  if (field === "_id") return { _id: dir };
  return { [field]: dir, _id: dir };
}
