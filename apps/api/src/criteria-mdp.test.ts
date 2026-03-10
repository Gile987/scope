// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  computeMdp,
  mergeMdpResponses,
  parseStateKey,
  type MdpAnalyzableRun,
} from "./criteria-mdp.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRun(
  criteria: string[],
  turns: Array<Record<string, boolean>>,
  status = "completed"
): MdpAnalyzableRun {
  return {
    scenario: { criteria },
    status,
    turns: turns.map((turnState, i) => ({
      iteration: i + 1,
      criteriaResults: Object.entries(turnState).map(([id, passed]) => ({
        criterionId: id,
        passed,
        evaluated: true,
      })),
    })),
  };
}

function makeRunWithFeatures(
  criteria: string[],
  turns: Array<Record<string, boolean>>,
  features: Array<{ featureId: string; detected: boolean }>,
  status = "completed"
): MdpAnalyzableRun {
  return {
    ...makeRun(criteria, turns, status),
    promptFeatures: features.map((f) => ({ ...f, evaluated: true })),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeMdp", () => {
  it("returns empty graph for no runs", () => {
    const result = computeMdp([]);
    expect(result.episodeCount).toBe(0);
    // No runs → no initial node created (nothing to anchor it to)
    expect(result.edges.length).toBe(0);
  });

  it("builds correct MDP for a single run with 2 turns", () => {
    const run = makeRun(["a", "b"], [
      { a: true, b: false },  // Turn 1: a passed, b failed
      { a: true, b: true },   // Turn 2: both passed
    ]);

    const result = computeMdp([run]);

    expect(result.episodeCount).toBe(1);
    // Nodes: initial (a:0|b:0) + turn1 (a:1|b:0) + turn2 (a:1|b:1) = 3
    expect(result.nodes.length).toBe(3);

    // Initial node
    const initial = result.nodes.find((n) => n.isInitial);
    expect(initial).toBeDefined();
    expect(initial!.criteria.every((c) => !c.passed)).toBe(true);
    expect(initial!.visits).toBe(1);

    // Terminal node (a:1|b:1 — all passed)
    const terminal = result.nodes.find((n) => n.isTerminal);
    expect(terminal).toBeDefined();
    expect(terminal!.criteria.every((c) => c.passed)).toBe(true);

    // 2 edges: initial→turn1, turn1→turn2
    expect(result.edges.length).toBe(2);
    for (const edge of result.edges) {
      expect(edge.probability).toBe(1.0);
      expect(edge.count).toBe(1);
    }
  });

  it("merges identical states from different episodes", () => {
    const run1 = makeRun(["a", "b"], [
      { a: true, b: false },
      { a: true, b: true },
    ]);
    const run2 = makeRun(["a", "b"], [
      { a: true, b: false },  // Same state as run1 turn1
      { a: true, b: true },
    ]);

    const result = computeMdp([run1, run2]);

    expect(result.episodeCount).toBe(2);
    // Same 3 unique states as a single run
    expect(result.nodes.length).toBe(3);

    // Initial node visited twice
    const initial = result.nodes.find((n) => n.isInitial);
    expect(initial!.visits).toBe(2);

    // The intermediate state visited twice
    const mid = result.nodes.find(
      (n) => !n.isInitial && !n.isTerminal
    );
    expect(mid).toBeDefined();
    expect(mid!.visits).toBe(2);

    // Edges: all have count=2, probability=1.0
    for (const edge of result.edges) {
      expect(edge.count).toBe(2);
      expect(edge.probability).toBe(1.0);
    }
  });

  it("computes correct probabilities for branching transitions", () => {
    // Run 1: initial → (a:1,b:0) → (a:1,b:1)
    const run1 = makeRun(["a", "b"], [
      { a: true, b: false },
      { a: true, b: true },
    ]);
    // Run 2: initial → (a:0,b:1) → (a:1,b:1)
    const run2 = makeRun(["a", "b"], [
      { a: false, b: true },
      { a: true, b: true },
    ]);

    const result = computeMdp([run1, run2]);

    expect(result.episodeCount).toBe(2);
    // Nodes: initial + (a:1,b:0) + (a:0,b:1) + (a:1,b:1) = 4
    expect(result.nodes.length).toBe(4);

    // Initial should have 2 outgoing edges, each with probability 0.5
    const initialEdges = result.edges.filter((e) => {
      const initial = result.nodes.find((n) => n.isInitial);
      return e.source === initial!.id;
    });
    expect(initialEdges.length).toBe(2);
    for (const edge of initialEdges) {
      expect(edge.probability).toBeCloseTo(0.5);
      expect(edge.count).toBe(1);
    }
  });

  it("handles self-loops (state doesn't change between turns)", () => {
    const run = makeRun(["a"], [
      { a: false },  // Turn 1
      { a: false },  // Turn 2 — same state
      { a: true },   // Turn 3
    ]);

    const result = computeMdp([run]);

    expect(result.episodeCount).toBe(1);
    // Nodes: initial (a:0) + (a:1) = 2 (initial and turn1/2 are the same state a:0)
    expect(result.nodes.length).toBe(2);

    // There should be a self-loop on the initial/a:0 state
    // Count=2: initial→turn1(a:0) + turn1(a:0)→turn2(a:0)
    const selfLoop = result.edges.find((e) => e.source === e.target);
    expect(selfLoop).toBeDefined();
    expect(selfLoop!.count).toBe(2);
  });

  it("projects to selected criteria subset", () => {
    // Run has 3 criteria but we project to only [a, b]
    const run = makeRun(["a", "b", "c"], [
      { a: true, b: false, c: true },
      { a: true, b: true, c: false },
    ]);

    const result = computeMdp([run], ["a", "b"]);

    expect(result.selectedCriteria).toEqual(["a", "b"]);
    // All state vectors should only have a and b
    for (const node of result.nodes) {
      const ids = node.criteria.map((c) => c.id);
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).not.toContain("c");
    }
  });

  it("collapses states that differ only in excluded criteria", () => {
    // Run 1: turns with c=true
    const run1 = makeRun(["a", "b", "c"], [
      { a: true, b: false, c: true },
    ]);
    // Run 2: turns with c=false but same a,b
    const run2 = makeRun(["a", "b", "c"], [
      { a: true, b: false, c: false },
    ]);

    // Without projection: 2 distinct turn1 states
    const full = computeMdp([run1, run2]);
    const nonInitialFull = full.nodes.filter((n) => !n.isInitial);
    expect(nonInitialFull.length).toBe(2);

    // With projection to [a, b]: turn1 states collapse into 1
    const projected = computeMdp([run1, run2], ["a", "b"]);
    const nonInitialProjected = projected.nodes.filter((n) => !n.isInitial);
    expect(nonInitialProjected.length).toBe(1);
    expect(nonInitialProjected[0].visits).toBe(2);
  });

  it("handles single-turn episodes", () => {
    const run = makeRun(["a"], [{ a: true }]);
    const result = computeMdp([run]);

    expect(result.episodeCount).toBe(1);
    // initial + terminal = 2 nodes
    expect(result.nodes.length).toBe(2);
    // 1 edge: initial → terminal
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].probability).toBe(1.0);
  });

  it("skips runs with no turns", () => {
    const run: MdpAnalyzableRun = {
      scenario: { criteria: ["a"] },
      status: "completed",
      turns: [],
    };
    const result = computeMdp([run]);
    expect(result.episodeCount).toBe(0);
  });

  it("treats unevaluated criteria as failed", () => {
    const run: MdpAnalyzableRun = {
      scenario: { criteria: ["a", "b"] },
      status: "completed",
      turns: [
        {
          iteration: 1,
          criteriaResults: [
            { criterionId: "a", passed: true, evaluated: true },
            { criterionId: "b", passed: false, evaluated: false }, // Skipped
          ],
        },
      ],
    };
    const result = computeMdp([run]);
    const terminal = result.nodes.find((n) => n.isTerminal);
    const bState = terminal!.criteria.find((c) => c.id === "b");
    expect(bState!.passed).toBe(false);
  });

  it("includes availableCriteria from all runs", () => {
    const run1 = makeRun(["a", "b"], [{ a: true, b: true }]);
    const run2 = makeRun(["b", "c"], [{ b: true, c: false }]);
    const result = computeMdp([run1, run2]);
    expect(result.availableCriteria).toEqual(["a", "b", "c"]);
  });

  it("probabilities sum to 1.0 for each source node", () => {
    const run1 = makeRun(["a", "b"], [
      { a: true, b: false },
      { a: true, b: true },
    ]);
    const run2 = makeRun(["a", "b"], [
      { a: false, b: true },
      { a: true, b: true },
    ]);
    const run3 = makeRun(["a", "b"], [
      { a: true, b: false },
      { a: false, b: true },
    ]);

    const result = computeMdp([run1, run2, run3]);

    // Group edges by source and check probabilities sum to ~1.0
    const bySource = new Map<string, number>();
    for (const edge of result.edges) {
      bySource.set(
        edge.source,
        (bySource.get(edge.source) || 0) + edge.probability
      );
    }
    for (const [, total] of bySource) {
      expect(total).toBeCloseTo(1.0);
    }
  });
});

describe("mergeMdpResponses", () => {
  it("merges nodes by summing visits", () => {
    const base = computeMdp([
      makeRun(["a"], [{ a: true }]),
    ]);
    const delta = computeMdp([
      makeRun(["a"], [{ a: true }]),
    ]);

    const merged = mergeMdpResponses(base, delta);

    expect(merged.episodeCount).toBe(2);
    const terminal = merged.nodes.find((n) => n.isTerminal);
    expect(terminal!.visits).toBe(2);
  });

  it("adds new nodes from delta", () => {
    const base = computeMdp([
      makeRun(["a"], [{ a: true }]),
    ]);
    const delta = computeMdp([
      makeRun(["a"], [{ a: false }]),
    ]);

    const merged = mergeMdpResponses(base, delta);

    // base has: initial (a:0), terminal (a:1)
    // delta has: initial (a:0), terminal (a:0) — but a:0 is the initial state
    // Actually delta terminal is a:0 which is the same as initial 
    // So merged should have 2 nodes: a:0 (initial) and a:1:
    expect(merged.nodes.length).toBe(2);
  });

  it("recomputes probabilities after merge", () => {
    // Base: initial → a:1 (100%)
    const base = computeMdp([
      makeRun(["a"], [{ a: true }]),
    ]);
    // Delta: initial → a:0 (self-loop, then a:1)
    const delta = computeMdp([
      makeRun(["a"], [{ a: false }, { a: true }]),
    ]);

    const merged = mergeMdpResponses(base, delta);

    // From initial (a:0), there should be 2 outgoing edges:
    // initial → a:1 (from base) and initial → a:0 (self-loop from delta)
    const initial = merged.nodes.find((n) => n.isInitial)!;
    const fromInitial = merged.edges.filter((e) => e.source === initial.id);
    const totalProb = fromInitial.reduce((sum, e) => sum + e.probability, 0);
    expect(totalProb).toBeCloseTo(1.0);
  });

  it("returns existing with updated timestamp when delta is empty", () => {
    const base = computeMdp([
      makeRun(["a"], [{ a: true }]),
    ]);
    const emptyDelta: typeof base = {
      ...base,
      nodes: [],
      edges: [],
      episodeCount: 0,
      computedAt: "2026-01-01T00:00:00.000Z",
    };

    const merged = mergeMdpResponses(base, emptyDelta);
    expect(merged.episodeCount).toBe(base.episodeCount);
    expect(merged.nodes.length).toBe(base.nodes.length);
    expect(merged.computedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("merges availableCriteria from both", () => {
    const base = computeMdp([makeRun(["a"], [{ a: true }])]);
    const delta = computeMdp([makeRun(["b"], [{ b: false }])]);

    const merged = mergeMdpResponses(base, delta);
    expect(merged.availableCriteria).toContain("a");
    expect(merged.availableCriteria).toContain("b");
  });

  it("merges availablePromptFeatures from both", () => {
    const base = computeMdp([
      makeRunWithFeatures(["a"], [{ a: true }], [{ featureId: "f1", detected: true }]),
    ]);
    const delta = computeMdp([
      makeRunWithFeatures(["a"], [{ a: false }], [{ featureId: "f2", detected: false }]),
    ]);

    const merged = mergeMdpResponses(base, delta);
    expect(merged.availablePromptFeatures).toContain("f1");
    expect(merged.availablePromptFeatures).toContain("f2");
  });
});

// ─── Prompt Feature Start Nodes ──────────────────────────────────────────────

describe("computeMdp with prompt features", () => {
  it("uses prompt features as start nodes instead of synthetic initial", () => {
    const run = makeRunWithFeatures(
      ["a", "b"],
      [{ a: true, b: false }, { a: true, b: true }],
      [{ featureId: "azure", detected: true }, { featureId: "docker", detected: false }]
    );

    const result = computeMdp([run]);

    // Start node should be a prompt-features node
    const startNode = result.nodes.find((n) => n.isInitial);
    expect(startNode).toBeDefined();
    expect(startNode!.type).toBe("prompt-features");
    expect(startNode!.features).toBeDefined();
    expect(startNode!.features!.length).toBe(2);
    expect(startNode!.features!.find((f) => f.id === "azure")?.detected).toBe(true);
    expect(startNode!.features!.find((f) => f.id === "docker")?.detected).toBe(false);
    // Criteria should be empty on feature nodes
    expect(startNode!.criteria.length).toBe(0);

    // Criteria state nodes should have type "criteria"
    const criteriaNodes = result.nodes.filter((n) => n.type === "criteria");
    expect(criteriaNodes.length).toBe(2); // turn1 + turn2 states
  });

  it("groups runs with same feature vector into same start node", () => {
    const run1 = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [{ featureId: "azure", detected: true }]
    );
    const run2 = makeRunWithFeatures(
      ["a"],
      [{ a: false }],
      [{ featureId: "azure", detected: true }]
    );

    const result = computeMdp([run1, run2]);

    // Both runs share the same feature start node
    const startNodes = result.nodes.filter((n) => n.isInitial);
    expect(startNodes.length).toBe(1);
    expect(startNodes[0].visits).toBe(2);
    expect(startNodes[0].type).toBe("prompt-features");
  });

  it("creates separate start nodes for different feature vectors", () => {
    const run1 = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [{ featureId: "azure", detected: true }]
    );
    const run2 = makeRunWithFeatures(
      ["a"],
      [{ a: false }],
      [{ featureId: "azure", detected: false }]
    );

    const result = computeMdp([run1, run2]);

    const startNodes = result.nodes.filter((n) => n.isInitial);
    expect(startNodes.length).toBe(2);
    expect(startNodes.every((n) => n.type === "prompt-features")).toBe(true);
  });

  it("creates 'Unknown' start node for runs without features", () => {
    const runWithFeatures = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [{ featureId: "azure", detected: true }]
    );
    const runWithoutFeatures = makeRun(["a"], [{ a: false }]);

    const result = computeMdp([runWithFeatures, runWithoutFeatures]);

    const startNodes = result.nodes.filter((n) => n.isInitial);
    expect(startNodes.length).toBe(2);

    // One known, one unknown
    const unknownNode = startNodes.find((n) => n.id === "F||unknown");
    expect(unknownNode).toBeDefined();
    expect(unknownNode!.features).toEqual([]);
    expect(unknownNode!.visits).toBe(1);
  });

  it("includes availablePromptFeatures in response", () => {
    const run = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [{ featureId: "azure", detected: true }, { featureId: "docker", detected: false }]
    );

    const result = computeMdp([run]);
    expect(result.availablePromptFeatures).toEqual(["azure", "docker"]);
  });

  it("filters runs by selectedFeatures (AND logic)", () => {
    const run1 = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [{ featureId: "azure", detected: true }, { featureId: "docker", detected: true }]
    );
    const run2 = makeRunWithFeatures(
      ["a"],
      [{ a: false }],
      [{ featureId: "azure", detected: true }] // missing docker
    );

    const result = computeMdp([run1, run2], undefined, ["azure", "docker"]);

    // Only run1 should be included (run2 doesn't have docker feature evaluated)
    expect(result.episodeCount).toBe(1);
    expect(result.selectedFeatures).toEqual(["azure", "docker"]);
  });

  it("projects feature start nodes to selected features only", () => {
    const run = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [
        { featureId: "azure", detected: true },
        { featureId: "docker", detected: false },
        { featureId: "k8s", detected: true },
      ]
    );

    const result = computeMdp([run], undefined, ["azure", "docker"]);

    const startNode = result.nodes.find((n) => n.isInitial);
    expect(startNode!.features!.length).toBe(2);
    const featureIds = startNode!.features!.map((f) => f.id);
    expect(featureIds).toContain("azure");
    expect(featureIds).toContain("docker");
    expect(featureIds).not.toContain("k8s");
  });

  it("applies both criteria AND features filters", () => {
    // Run1: has criteria a,b and feature azure
    const run1 = makeRunWithFeatures(
      ["a", "b"],
      [{ a: true, b: true }],
      [{ featureId: "azure", detected: true }]
    );
    // Run2: has criteria a (missing b) and feature azure
    const run2 = makeRunWithFeatures(
      ["a"],
      [{ a: true }],
      [{ featureId: "azure", detected: true }]
    );
    // Run3: has criteria a,b but no features
    const run3 = makeRun(["a", "b"], [{ a: true, b: false }]);

    const result = computeMdp([run1, run2, run3], ["a", "b"], ["azure"]);

    // Only run1 passes both filters
    expect(result.episodeCount).toBe(1);
  });

  it("falls back to synthetic initial when no runs have features", () => {
    const run = makeRun(["a"], [{ a: true }]);
    const result = computeMdp([run]);

    const startNode = result.nodes.find((n) => n.isInitial);
    expect(startNode).toBeDefined();
    // No type set (backward compat) or undefined
    expect(startNode!.criteria.length).toBeGreaterThan(0);
    expect(result.availablePromptFeatures).toEqual([]);
  });
});

// ─── parseStateKey ───────────────────────────────────────────────────────────

describe("parseStateKey", () => {
  it("parses a single criterion", () => {
    expect(parseStateKey("has_azure:1")).toEqual([
      { id: "has_azure", passed: true },
    ]);
  });

  it("parses multiple criteria", () => {
    expect(parseStateKey("has_azure:0|has_cloud:1")).toEqual([
      { id: "has_azure", passed: false },
      { id: "has_cloud", passed: true },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseStateKey("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseStateKey("  ")).toEqual([]);
  });

  it("handles criteria with colons in the ID", () => {
    // e.g. a namespaced criterion "ns:foo:1" → id="ns:foo", passed=true
    expect(parseStateKey("ns:foo:1")).toEqual([
      { id: "ns:foo", passed: true },
    ]);
  });

  it("round-trips with computeMdp stateKey format", () => {
    // Verify parseStateKey can parse output from computeMdp nodes
    const run = makeRun(["b", "a"], [{ a: true, b: false }]);
    const result = computeMdp([run]);
    const criteriaNode = result.nodes.find(
      (n) => n.type !== "prompt-features" && !n.isInitial && n.criteria.length > 0
    );
    if (criteriaNode) {
      const parsed = parseStateKey(criteriaNode.id);
      expect(parsed).toEqual(
        criteriaNode.criteria.map((c) => ({ id: c.id, passed: c.passed }))
      );
    }
  });
});
