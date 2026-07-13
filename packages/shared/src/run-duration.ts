// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for the denormalized `run.durationMs` field (issue #1138).
 *
 * Duration = `run.finishedAt − run.startedAt` (ms) is computed, so it cannot be
 * sorted/indexed directly. We denormalize it onto the run sub-document whenever
 * a run reaches a terminal state, and backfill existing finished runs in a
 * migration. Unfinished runs (or runs missing a timestamp) leave it unset and
 * sort null-last.
 */

/** Compute finishedAt − startedAt in ms, or undefined when either is missing/invalid. */
export function runDurationMs(
  startedAt?: Date | string | null,
  finishedAt?: Date | string | null,
): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const s = new Date(startedAt).getTime();
  const f = new Date(finishedAt).getTime();
  if (Number.isNaN(s) || Number.isNaN(f)) return undefined;
  return f - s;
}

/**
 * `$set` fragment denormalizing `run.durationMs`. Spread into an existing plain
 * `$set` object at completion sites where `startedAt` is already in scope —
 * zero extra cost and safe (a literal number, never a `$`-prefixed string).
 * Returns `{}` when the duration can't be computed.
 */
export function durationSetFields(
  startedAt?: Date | string | null,
  finishedAt?: Date | string | null,
): { "run.durationMs"?: number } {
  const d = runDurationMs(startedAt, finishedAt);
  return d === undefined ? {} : { "run.durationMs": d };
}
