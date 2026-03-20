// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { DependencyGraph, type DependencyNode, type DependencyResult } from "./dependency-graph.js";

// Minimal node factory helpers
const node = (id: string, dependsOn: string[] = []): DependencyNode => ({ id, dependsOn });

describe("DependencyGraph", () => {
  describe("construction", () => {
    it("builds an empty graph", () => {
      const graph = new DependencyGraph([]);
      expect(graph.getAllNodes()).toEqual([]);
    });

    it("builds a graph with nodes that have no dependencies", () => {
      const graph = new DependencyGraph([node("a"), node("b"), node("c")]);
      expect(graph.getAllNodes()).toHaveLength(3);
    });

    it("builds a graph with a linear chain", () => {
      const graph = new DependencyGraph([
        node("a"),
        node("b", ["a"]),
        node("c", ["b"]),
      ]);
      expect(graph.getNode("c")).toBeDefined();
    });

    it("throws on duplicate node ids", () => {
      expect(() =>
        new DependencyGraph([node("a"), node("a")])
      ).toThrow("Duplicate node id 'a'");
    });

    it("throws when a node depends on an unknown id", () => {
      expect(() =>
        new DependencyGraph([node("a", ["missing"])])
      ).toThrow("unknown node 'missing'");
    });

    it("throws when there is a direct cycle (a -> b -> a)", () => {
      expect(() =>
        new DependencyGraph([node("a", ["b"]), node("b", ["a"])])
      ).toThrow(/[Cc]ycle/);
    });

    it("throws when there is a longer cycle (a -> b -> c -> a)", () => {
      expect(() =>
        new DependencyGraph([
          node("a", ["c"]),
          node("b", ["a"]),
          node("c", ["b"]),
        ])
      ).toThrow(/[Cc]ycle/);
    });

    it("accepts a diamond DAG (no cycle)", () => {
      //   a
      //  / \
      // b   c
      //  \ /
      //   d
      expect(() =>
        new DependencyGraph([
          node("a"),
          node("b", ["a"]),
          node("c", ["a"]),
          node("d", ["b", "c"]),
        ])
      ).not.toThrow();
    });
  });

  describe("topologicalSort", () => {
    it("returns single node", () => {
      const graph = new DependencyGraph([node("a")]);
      expect(graph.topologicalSort()).toEqual(["a"]);
    });

    it("returns parents before children in a chain", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"]), node("c", ["b"])]);
      const order = graph.topologicalSort();
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    });

    it("includes all nodes", () => {
      const graph = new DependencyGraph([node("a"), node("b"), node("c", ["a", "b"])]);
      const order = graph.topologicalSort();
      expect(order).toHaveLength(3);
      expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
    });

    it("returns parent before child in a diamond DAG", () => {
      const graph = new DependencyGraph([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      const order = graph.topologicalSort();
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
      expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    });
  });

  describe("getAncestors", () => {
    it("returns empty set for node with no parents", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"])]);
      expect(graph.getAncestors("a").size).toBe(0);
    });

    it("returns direct parent", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"])]);
      expect(graph.getAncestors("b")).toEqual(new Set(["a"]));
    });

    it("returns transitive ancestors (chain)", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"]), node("c", ["b"])]);
      expect(graph.getAncestors("c")).toEqual(new Set(["a", "b"]));
    });

    it("returns all ancestors in a diamond DAG", () => {
      const graph = new DependencyGraph([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      expect(graph.getAncestors("d")).toEqual(new Set(["a", "b", "c"]));
    });

    it("returns empty set for unknown node id", () => {
      const graph = new DependencyGraph([node("a")]);
      expect(graph.getAncestors("unknown").size).toBe(0);
    });
  });

  describe("getDescendants", () => {
    it("returns empty set for leaf node", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"])]);
      expect(graph.getDescendants("b").size).toBe(0);
    });

    it("returns direct child", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"])]);
      expect(graph.getDescendants("a")).toEqual(new Set(["b"]));
    });

    it("returns transitive descendants (chain)", () => {
      const graph = new DependencyGraph([node("a"), node("b", ["a"]), node("c", ["b"])]);
      expect(graph.getDescendants("a")).toEqual(new Set(["b", "c"]));
    });

    it("returns all descendants in a diamond DAG", () => {
      const graph = new DependencyGraph([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
      ]);
      expect(graph.getDescendants("a")).toEqual(new Set(["b", "c", "d"]));
    });
  });

  describe("getRootFailures", () => {
    const makeGraph = () =>
      new DependencyGraph([node("a"), node("b", ["a"]), node("c", ["b"]), node("d")]);

    describe("with CriterionResult format (criterionId/passed)", () => {
      it("returns all failures when no ancestors failed", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { criterionId: "a", passed: false },
          { criterionId: "d", passed: false },
        ];
        const roots = graph.getRootFailures(results);
        expect(roots).toHaveLength(2);
      });

      it("excludes downstream failures when ancestor fails", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { criterionId: "a", passed: false },
          { criterionId: "b", passed: false }, // downstream of a
          { criterionId: "c", passed: false }, // downstream of a via b
        ];
        const roots = graph.getRootFailures(results);
        expect(roots).toHaveLength(1);
        expect(roots[0].criterionId).toBe("a");
      });

      it("does not include passing results", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { criterionId: "a", passed: true },
          { criterionId: "b", passed: false },
        ];
        const roots = graph.getRootFailures(results);
        expect(roots).toHaveLength(1);
        expect(roots[0].criterionId).toBe("b");
      });

      it("returns empty array when all pass", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { criterionId: "a", passed: true },
          { criterionId: "b", passed: true },
        ];
        expect(graph.getRootFailures(results)).toHaveLength(0);
      });
    });

    describe("with PromptFeatureResult format (featureId/detected)", () => {
      it("returns root failures for featureId/detected format", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { featureId: "a", detected: false },
          { featureId: "b", detected: false }, // downstream of a
        ];
        const roots = graph.getRootFailures(results);
        expect(roots).toHaveLength(1);
        expect(roots[0].featureId).toBe("a");
      });

      it("treats detected===false as failure", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { featureId: "d", detected: false },
        ];
        expect(graph.getRootFailures(results)).toHaveLength(1);
      });

      it("treats detected===true as passing", () => {
        const graph = makeGraph();
        const results: DependencyResult[] = [
          { featureId: "d", detected: true },
        ];
        expect(graph.getRootFailures(results)).toHaveLength(0);
      });
    });
  });

  describe("getNode / getAllNodes", () => {
    it("getNode returns node by id", () => {
      const a = node("a");
      const graph = new DependencyGraph([a]);
      expect(graph.getNode("a")).toEqual(a);
    });

    it("getNode returns undefined for unknown id", () => {
      const graph = new DependencyGraph([node("a")]);
      expect(graph.getNode("zzz")).toBeUndefined();
    });

    it("getAllNodes returns all nodes", () => {
      const nodes = [node("a"), node("b", ["a"])];
      const graph = new DependencyGraph(nodes);
      expect(graph.getAllNodes()).toHaveLength(2);
    });
  });
});
