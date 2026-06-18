// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { layoutGraph, detectCycles } from "./CriteriaGraphView";
import type { CriteriaGraphData } from "@/types";

function node(id: string) {
  return { id, prompt: id, dependsOn: [] as string[], gates: undefined };
}

function graphOf(ids: string[], edges: Array<[string, string]>): CriteriaGraphData {
  return {
    nodes: ids.map(node),
    edges: edges.map(([source, target]) => ({ source, target })),
  } as unknown as CriteriaGraphData;
}

describe("layoutGraph", () => {
  it("lays out an acyclic graph with all nodes positioned", () => {
    const graph = graphOf(["a", "b", "c"], [
      ["a", "b"],
      ["a", "c"],
    ]);

    const { positions } = layoutGraph(graph);
    expect(positions.size).toBe(3);
    expect([...positions.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  // Regression: a cyclic subgraph (e.g. the Test gate where the data contains a
  // back-edge) used to leave Kahn's algorithm with no in-degree-0 root, yielding
  // empty positions and a blank canvas. Every node must still be placed.
  it("still positions every node when the graph contains a cycle", () => {
    const graph = graphOf(["tests_pass", "has_70p", "has_90p"], [
      ["tests_pass", "has_70p"],
      ["tests_pass", "has_90p"],
      ["has_70p", "has_90p"],
      ["has_90p", "tests_pass"], // back-edge → cycle
    ]);

    const { positions, totalW, totalH } = layoutGraph(graph);
    expect(positions.size).toBe(3);
    expect([...positions.keys()].sort()).toEqual(["has_70p", "has_90p", "tests_pass"]);
    expect(Number.isFinite(totalW)).toBe(true);
    expect(Number.isFinite(totalH)).toBe(true);
  });

  it("surfaces cycle info through the layout result", () => {
    const graph = graphOf(["x", "y"], [
      ["x", "y"],
      ["y", "x"],
    ]);
    const { cycleEdges, cycleNodes, cycleGroups } = layoutGraph(graph);
    expect(cycleEdges.size).toBe(2);
    expect(cycleNodes.size).toBe(2);
    expect(cycleGroups.length).toBe(1);
  });
});

describe("detectCycles", () => {
  it("reports no cycles for an acyclic graph", () => {
    const { nodes, edges } = graphOf(["a", "b", "c"], [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    const { cycleNodes, cycleEdges, cycleGroups } = detectCycles(nodes, edges);
    expect(cycleNodes.size).toBe(0);
    expect(cycleEdges.size).toBe(0);
    expect(cycleGroups.length).toBe(0);
  });

  // The whole SCC participates in the loop, regardless of which edge "closes"
  // it. All three nodes are mutually reachable, so all are flagged — and every
  // edge among them is a cycle edge. This is stable across node ordering.
  it("flags every node and edge in a three-node cycle", () => {
    const { nodes, edges } = graphOf(["tests_pass", "has_70p", "has_90p"], [
      ["tests_pass", "has_70p"],
      ["has_70p", "has_90p"],
      ["has_90p", "tests_pass"],
    ]);
    const { cycleNodes, cycleEdges, cycleGroups } = detectCycles(nodes, edges);
    expect([...cycleNodes].sort()).toEqual(["has_70p", "has_90p", "tests_pass"]);
    expect(cycleEdges.size).toBe(3);
    expect(cycleGroups.length).toBe(1);
    expect([...cycleGroups[0]].sort()).toEqual(["has_70p", "has_90p", "tests_pass"]);
  });

  it("does not flag a non-cycle edge that merely points into a cycle", () => {
    // root → a → b → a (a,b form the cycle; root is acyclic).
    const { nodes, edges } = graphOf(["root", "a", "b"], [
      ["root", "a"],
      ["a", "b"],
      ["b", "a"],
    ]);
    const { cycleNodes, cycleEdges } = detectCycles(nodes, edges);
    expect([...cycleNodes].sort()).toEqual(["a", "b"]);
    expect(cycleEdges.has("root->a")).toBe(false);
    expect(cycleEdges.has("a->b")).toBe(true);
    expect(cycleEdges.has("b->a")).toBe(true);
  });

  it("flags a self-dependency as a cycle", () => {
    const { nodes, edges } = graphOf(["a", "b"], [
      ["a", "a"],
      ["a", "b"],
    ]);
    const { cycleNodes, cycleEdges, cycleGroups } = detectCycles(nodes, edges);
    expect(cycleNodes.has("a")).toBe(true);
    expect(cycleNodes.has("b")).toBe(false);
    expect(cycleEdges.has("a->a")).toBe(true);
    expect(cycleGroups.length).toBe(1);
  });

  it("detects two independent cycles as separate groups", () => {
    const { nodes, edges } = graphOf(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "a"],
      ["c", "d"],
      ["d", "c"],
    ]);
    const { cycleGroups, cycleNodes } = detectCycles(nodes, edges);
    expect(cycleGroups.length).toBe(2);
    expect(cycleNodes.size).toBe(4);
  });
});
