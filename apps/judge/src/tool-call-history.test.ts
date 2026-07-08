// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  buildToolCallHistory,
  stableStringify,
  callMatchesIteration,
  toIterationGroup,
} from "./tool-call-history.js";

// Assembly/dedup/cap for the cumulative, run-wide tool-call history that the
// judge's list_tool_calls / search_tool_outputs / get_tool_output tools operate
// on. See scope #1255.
describe("tool-call history assembly (issue #1255)", () => {
  it("stableStringify sorts object keys so argument order doesn't matter", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    // Arrays keep their order (order is semantically meaningful there).
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    // Nested objects sort recursively.
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }));
  });

  it("flattens per-iteration groups into one chronological, globally-indexed list", () => {
    const history = buildToolCallHistory([
      { iteration: 2, toolCalls: [{ id: "b", name: "bash", arguments: { command: "build" }, response: "ok" }] },
      { iteration: 1, toolCalls: [{ id: "a", name: "bash", arguments: { command: "scaffold" }, response: "done" }] },
    ]);
    // Sorted by iteration: scaffold (it1) first, build (it2) second.
    expect(history.calls.map((c) => c.index)).toEqual([0, 1]);
    expect(history.calls[0].iteration).toBe(1);
    expect(history.calls[0].arguments.command).toBe("scaffold");
    expect(history.calls[1].iteration).toBe(2);
    expect(history.iterationsCovered).toEqual([1, 2]);
    expect(history.rawCount).toBe(2);
  });

  it("dedups byte-identical calls across iterations and annotates occurrences", () => {
    const identical = { id: "x", name: "bash", arguments: { command: "npm test" }, response: "1 passing" };
    const history = buildToolCallHistory([
      { iteration: 1, toolCalls: [identical] },
      { iteration: 2, toolCalls: [identical] },
    ]);
    expect(history.calls).toHaveLength(1);
    expect(history.rawCount).toBe(2);
    expect(history.calls[0].occurrences).toBe(2);
    expect(history.calls[0].iterations).toEqual([1, 2]);
    // callMatchesIteration sees BOTH iterations for the deduped entry.
    expect(callMatchesIteration(history.calls[0], 1)).toBe(true);
    expect(callMatchesIteration(history.calls[0], 2)).toBe(true);
    expect(callMatchesIteration(history.calls[0], 3)).toBe(false);
  });

  it("keeps calls with the same command but a CHANGED response as separate entries", () => {
    // A changed build/test output can signal a regression and must never be hidden.
    const history = buildToolCallHistory([
      { iteration: 1, toolCalls: [{ id: "1", name: "bash", arguments: { command: "npm test" }, response: "1 failing" }] },
      { iteration: 2, toolCalls: [{ id: "2", name: "bash", arguments: { command: "npm test" }, response: "1 passing" }] },
    ]);
    expect(history.calls).toHaveLength(2);
  });

  it("dedups regardless of argument key order (stable key)", () => {
    const history = buildToolCallHistory([
      { iteration: 1, toolCalls: [{ id: "1", name: "t", arguments: { a: 1, b: 2 }, response: "r" }] },
      { iteration: 2, toolCalls: [{ id: "2", name: "t", arguments: { b: 2, a: 1 }, response: "r" }] },
    ]);
    expect(history.calls).toHaveLength(1);
    expect(history.calls[0].occurrences).toBe(2);
  });

  it("truncates oversized responses at the retention cap and records the original length", () => {
    const huge = "z".repeat(500);
    const history = buildToolCallHistory(
      [{ iteration: 1, toolCalls: [{ id: "1", name: "bash", arguments: {}, response: huge }] }],
      { maxResponseBytes: 100 }
    );
    expect(history.calls[0].response.length).toBe(100);
    expect(history.calls[0].responseTruncated).toBe(true);
    expect(history.calls[0].responseLength).toBe(500);
  });

  it("tolerates tool calls with no response (treated as empty, still deduped)", () => {
    const history = buildToolCallHistory([
      { iteration: 1, toolCalls: [{ id: "1", name: "bash", arguments: { command: "ls" } }] },
      { iteration: 2, toolCalls: [{ id: "2", name: "bash", arguments: { command: "ls" } }] },
    ]);
    expect(history.calls).toHaveLength(1);
    expect(history.calls[0].response).toBe("");
    expect(history.calls[0].occurrences).toBe(2);
  });

  it("returns an empty history for no iterations", () => {
    const history = buildToolCallHistory([]);
    expect(history.calls).toEqual([]);
    expect(history.iterationsCovered).toEqual([]);
    expect(history.rawCount).toBe(0);
  });

  it("toIterationGroup wraps a single iteration's tool calls", () => {
    const group = toIterationGroup(3, [{ id: "1", name: "bash", arguments: {}, response: "x" }]);
    expect(group).toEqual({
      iteration: 3,
      toolCalls: [{ id: "1", name: "bash", arguments: {}, response: "x" }],
    });
  });
});
