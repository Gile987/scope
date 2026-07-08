// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { IterationToolCalls, ToolCall } from "shared";

/**
 * A single tool call flattened out of the per-iteration
 * {@link IterationToolCalls} groups into one run-wide list, deduplicated across
 * iterations and tagged with a stable global index. This is the canonical shape
 * the judge's tool-call tools (`list_tool_calls`, `search_tool_outputs`,
 * `get_tool_output`) operate on. See scope #1255.
 */
export interface FlatToolCall {
  /** Stable 0-based index into the full deduped list. Referenced by
   *  `get_tool_output(index)` and returned by `search_tool_outputs`. */
  index: number;
  /** Iteration in which this call was first seen. */
  iteration: number;
  /** All iterations in which this exact call (name + arguments + response)
   *  occurred. Present only when it occurred in more than one iteration. */
  iterations?: number[];
  /** Number of times this exact call occurred across iterations. Present only
   *  when greater than 1. */
  occurrences?: number;
  name: string;
  arguments: Record<string, unknown>;
  /** Captured response, possibly truncated to the retention cap. */
  response: string;
  /** True if `response` was truncated at retention time (memory safeguard). */
  responseTruncated: boolean;
  /** Original response length before any retention truncation. */
  responseLength: number;
}

/**
 * The assembled, deduped, run-wide tool-call history. `calls` is the single
 * source of truth: `get_tool_output` indexes into it and `search_tool_outputs`
 * scans all of it, so a one-time action recorded in an early iteration stays
 * discoverable no matter how many iterations follow.
 */
export interface ToolCallHistory {
  /** Full deduped list across all iterations, in first-seen (chronological)
   *  order. Each entry's `index` equals its position here. */
  calls: FlatToolCall[];
  /** Sorted unique iteration numbers represented in `calls`. */
  iterationsCovered: number[];
  /** Total raw tool calls seen across all iterations before dedup. */
  rawCount: number;
}

/** Default per-response retention cap (bytes) to bound judge memory when a
 *  cumulative history carries very large command outputs. Full output beyond
 *  this is dropped from memory; `get_tool_output` reports the truncation. */
const DEFAULT_MAX_RESPONSE_BYTES = 200_000;

/**
 * Deterministic JSON stringify with recursively sorted object keys, so two tool
 * calls with the same arguments in a different key order still dedupe. Arrays
 * keep their order (order is semantically meaningful there).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Flattens per-iteration tool-call groups into one chronological, deduplicated
 * run-wide list.
 *
 * Dedup key is the exact triple `name` + `arguments` + `response`: only
 * byte-identical calls collapse, so a build/test command whose output *changed*
 * between iterations is always kept as a separate entry (a changed output can
 * signal a regression and must never be hidden). Identical repeats collapse
 * into a single entry annotated with `occurrences` and the `iterations` it
 * appeared in.
 *
 * @param iterations Per-iteration tool-call groups (any order; sorted here).
 * @param opts.maxResponseBytes Retention cap per response (default 200 KB).
 */
export function buildToolCallHistory(
  iterations: IterationToolCalls[],
  opts: { maxResponseBytes?: number } = {},
): ToolCallHistory {
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  // Chronological order so "first seen" and the global index are stable.
  const ordered = [...iterations].sort((a, b) => a.iteration - b.iteration);

  const byKey = new Map<string, FlatToolCall>();
  const list: FlatToolCall[] = [];
  let rawCount = 0;

  for (const group of ordered) {
    for (const tc of group.toolCalls) {
      rawCount++;
      const rawResponse = tc.response ?? "";
      const key = `${tc.name}\u0000${stableStringify(tc.arguments ?? {})}\u0000${rawResponse}`;

      const existing = byKey.get(key);
      if (existing) {
        // Same call seen again in a later (or same) iteration — annotate rather
        // than duplicate.
        const iters = existing.iterations ?? [existing.iteration];
        if (!iters.includes(group.iteration)) {
          iters.push(group.iteration);
          iters.sort((a, b) => a - b);
        }
        // `iterations` is meaningful only when the call spans MORE THAN ONE
        // distinct iteration; a same-iteration repeat leaves it unset (see doc
        // on FlatToolCall.iterations).
        if (iters.length > 1) existing.iterations = iters;
        existing.occurrences = (existing.occurrences ?? 1) + 1;
        continue;
      }

      const truncated = rawResponse.length > maxResponseBytes;
      const flat: FlatToolCall = {
        index: list.length,
        iteration: group.iteration,
        name: tc.name,
        arguments: (tc.arguments ?? {}) as Record<string, unknown>,
        response: truncated ? rawResponse.slice(0, maxResponseBytes) : rawResponse,
        responseTruncated: truncated,
        responseLength: rawResponse.length,
      };
      byKey.set(key, flat);
      list.push(flat);
    }
  }

  // Union each entry's first-seen iteration with its recurrence iterations, so
  // an iteration whose calls were ALL byte-identical to earlier ones (recorded
  // only in `iterations`, never as a first-seen `iteration`) is still counted.
  const coveredSet = new Set<number>();
  for (const c of list) {
    for (const it of c.iterations ?? [c.iteration]) coveredSet.add(it);
  }
  const iterationsCovered = [...coveredSet].sort((a, b) => a - b);

  return { calls: list, iterationsCovered, rawCount };
}

/**
 * True when a tool call belongs to a given iteration — either it was first seen
 * there, or it recurred there (tracked in `iterations`).
 */
export function callMatchesIteration(call: FlatToolCall, iteration: number): boolean {
  if (call.iteration === iteration) return true;
  return call.iterations?.includes(iteration) ?? false;
}

/**
 * Convenience for the (legacy) single-iteration path: wrap one iteration's tool
 * calls as an {@link IterationToolCalls} group.
 */
export function toIterationGroup(
  iteration: number,
  toolCalls: ToolCall[],
): IterationToolCalls {
  return { iteration, toolCalls };
}

/**
 * The subset of a conversation turn the judge server needs to locate that
 * iteration's captured tool calls. Kept structural (not the full
 * `ConversationTurn`) so the untyped request-body turns can be passed directly
 * without over-coupling to the transport shape.
 */
export interface ToolCallUrlTurn {
  /** 1-based iteration this turn was captured in (falls back to position). */
  iteration?: number;
  /** Blob URL of the iteration's captured tool calls, when present. */
  toolCallsUrl?: string;
}

/**
 * Resolves the 1-based iteration number currently being judged. Prefers an
 * explicit positive `iteration`; otherwise falls back to
 * `conversationHistory.length + 1` (the current turn follows all prior turns).
 * Accepts `unknown` because both values arrive untyped from the request body.
 * See scope #1255.
 */
export function resolveCurrentIteration(
  iteration: unknown,
  conversationHistory: unknown,
): number {
  if (typeof iteration === "number" && iteration > 0) return iteration;
  const priorTurns = Array.isArray(conversationHistory)
    ? conversationHistory.length
    : 0;
  return priorTurns + 1;
}

/**
 * Maps each iteration to the blob URL of its captured tool calls, in ascending
 * iteration order, ready for the judge to fetch. Prior iterations come from
 * `conversationHistory[].toolCallsUrl`; `currentToolCallsUrl` is applied last so
 * it OVERRIDES any collision on `currentIteration`. A turn missing a usable
 * string `toolCallsUrl` is skipped; a turn's iteration number falls back to its
 * 1-based position when absent or non-positive. Pure and deterministic (no IO)
 * so the judge's cumulative assembly is unit-testable independent of blob
 * storage. See scope #1255.
 */
export function mapIterationToolCallUrls(
  conversationHistory: unknown,
  currentToolCallsUrl: unknown,
  currentIteration: number,
): { iteration: number; url: string }[] {
  const urlByIteration = new Map<number, string>();

  if (Array.isArray(conversationHistory)) {
    (conversationHistory as ToolCallUrlTurn[]).forEach((turn, idx) => {
      const url = turn?.toolCallsUrl;
      if (typeof url === "string" && url) {
        const iterNum =
          typeof turn.iteration === "number" && turn.iteration > 0
            ? turn.iteration
            : idx + 1;
        urlByIteration.set(iterNum, url);
      }
    });
  }

  // Current iteration applied last → overrides any history collision.
  if (typeof currentToolCallsUrl === "string" && currentToolCallsUrl) {
    urlByIteration.set(currentIteration, currentToolCallsUrl);
  }

  return [...urlByIteration.entries()]
    .sort(([a], [b]) => a - b)
    .map(([iteration, url]) => ({ iteration, url }));
}
