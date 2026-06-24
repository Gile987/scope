// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { findCycles } from "./graph-cycles";

function graphOf(ids: string[], edges: Array<[string, string]>) {
  return {
    nodes: ids.map((id) => ({ id })),
    edges: edges.map(([source, target]) => ({ source, target })),
  };
}

describe("findCycles", () => {
  it("reports no cycles for an acyclic graph", () => {
    const { nodes, edges } = graphOf(["a", "b", "c"], [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    const { cycleNodes, cycleEdges, cycleGroups } = findCycles(nodes, edges);
    expect(cycleNodes.size).toBe(0);
    expect(cycleEdges.size).toBe(0);
    expect(cycleGroups.length).toBe(0);
  });

  it("flags both nodes and edges in a two-node cycle", () => {
    const { nodes, edges } = graphOf(["x", "y"], [
      ["x", "y"],
      ["y", "x"],
    ]);
    const { cycleNodes, cycleEdges, cycleGroups } = findCycles(nodes, edges);
    expect([...cycleNodes].sort()).toEqual(["x", "y"]);
    expect(cycleEdges.has("x->y")).toBe(true);
    expect(cycleEdges.has("y->x")).toBe(true);
    expect(cycleGroups.length).toBe(1);
  });

  // The whole SCC participates in the loop, regardless of which edge "closes"
  // it. All three nodes are mutually reachable, so all are flagged — and every
  // edge among them is a cycle edge. Stable across node ordering.
  it("flags every node and edge in a three-node cycle", () => {
    const { nodes, edges } = graphOf(["tests_pass", "has_70p", "has_90p"], [
      ["tests_pass", "has_70p"],
      ["has_70p", "has_90p"],
      ["has_90p", "tests_pass"],
    ]);
    const { cycleNodes, cycleEdges, cycleGroups } = findCycles(nodes, edges);
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
    const { cycleNodes, cycleEdges } = findCycles(nodes, edges);
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
    const { cycleNodes, cycleEdges, cycleGroups } = findCycles(nodes, edges);
    expect(cycleNodes.has("a")).toBe(true);
    expect(cycleNodes.has("b")).toBe(false);
    expect(cycleEdges.has("a->a")).toBe(true);
    expect(cycleEdges.has("a->b")).toBe(false);
    expect(cycleGroups.length).toBe(1);
  });

  it("detects two independent cycles as separate groups", () => {
    const { nodes, edges } = graphOf(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "a"],
      ["c", "d"],
      ["d", "c"],
    ]);
    const { cycleGroups, cycleNodes } = findCycles(nodes, edges);
    expect(cycleGroups.length).toBe(2);
    expect(cycleNodes.size).toBe(4);
  });

  it("ignores edges referencing unknown nodes", () => {
    const { nodes } = graphOf(["a", "b"], []);
    const edges = [
      { source: "a", target: "ghost" },
      { source: "ghost", target: "a" },
    ];
    const { cycleNodes, cycleEdges, cycleGroups } = findCycles(nodes, edges);
    expect(cycleNodes.size).toBe(0);
    expect(cycleEdges.size).toBe(0);
    expect(cycleGroups.length).toBe(0);
  });
});
