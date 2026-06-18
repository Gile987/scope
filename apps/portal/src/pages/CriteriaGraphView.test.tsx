// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { layoutGraph } from "./CriteriaGraphView";
import type { CriteriaGraphData } from "@/types";

function node(id: string) {
  return { id, prompt: id, dependsOn: [] as string[], gates: undefined };
}

describe("layoutGraph", () => {
  it("lays out an acyclic graph with all nodes positioned", () => {
    const graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    } as unknown as CriteriaGraphData;

    const { positions } = layoutGraph(graph);
    expect(positions.size).toBe(3);
    expect([...positions.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  // Regression: a cyclic subgraph (e.g. the Test gate where the data contains a
  // back-edge) used to leave Kahn's algorithm with no in-degree-0 root, yielding
  // empty positions and a blank canvas. Every node must still be placed.
  it("still positions every node when the graph contains a cycle", () => {
    const graph = {
      nodes: [node("tests_pass"), node("has_70p"), node("has_90p")],
      edges: [
        { source: "tests_pass", target: "has_70p" },
        { source: "tests_pass", target: "has_90p" },
        { source: "has_70p", target: "has_90p" },
        { source: "has_90p", target: "tests_pass" }, // back-edge → cycle
      ],
    } as unknown as CriteriaGraphData;

    const { positions, totalW, totalH } = layoutGraph(graph);
    expect(positions.size).toBe(3);
    expect([...positions.keys()].sort()).toEqual(["has_70p", "has_90p", "tests_pass"]);
    expect(Number.isFinite(totalW)).toBe(true);
    expect(Number.isFinite(totalH)).toBe(true);
  });

  it("handles a pure cycle with no roots at all", () => {
    const graph = {
      nodes: [node("x"), node("y")],
      edges: [
        { source: "x", target: "y" },
        { source: "y", target: "x" },
      ],
    } as unknown as CriteriaGraphData;

    const { positions } = layoutGraph(graph);
    expect(positions.size).toBe(2);
  });
});
