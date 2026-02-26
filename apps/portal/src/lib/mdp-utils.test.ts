// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { mergeMdpResponses, topologyHash } from "./mdp-utils";
import type { MdpResponse } from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMdpResponse(overrides: Partial<MdpResponse> = {}): MdpResponse {
  return {
    nodes: [],
    edges: [],
    episodeCount: 0,
    availableCriteria: [],
    selectedCriteria: [],
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("mergeMdpResponses", () => {
  it("returns existing unchanged when delta has 0 episodes", () => {
    const existing = makeMdpResponse({
      nodes: [
        { id: "a:0", criteria: [{ id: "a", passed: false }], visits: 3, isInitial: true },
      ],
      edges: [],
      episodeCount: 3,
      computedAt: "2026-01-01T00:00:00Z",
    });
    const delta = makeMdpResponse({
      episodeCount: 0,
      computedAt: "2026-02-01T00:00:00Z",
    });

    const merged = mergeMdpResponses(existing, delta);
    expect(merged.episodeCount).toBe(3);
    expect(merged.nodes.length).toBe(1);
    expect(merged.computedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("sums node visits for matching IDs", () => {
    const existing = makeMdpResponse({
      nodes: [
        { id: "a:1", criteria: [{ id: "a", passed: true }], visits: 5 },
      ],
      episodeCount: 5,
    });
    const delta = makeMdpResponse({
      nodes: [
        { id: "a:1", criteria: [{ id: "a", passed: true }], visits: 3 },
      ],
      episodeCount: 3,
    });

    const merged = mergeMdpResponses(existing, delta);
    expect(merged.nodes.find((n) => n.id === "a:1")!.visits).toBe(8);
    expect(merged.episodeCount).toBe(8);
  });

  it("adds new nodes from delta", () => {
    const existing = makeMdpResponse({
      nodes: [
        { id: "a:0", criteria: [{ id: "a", passed: false }], visits: 2 },
      ],
      episodeCount: 2,
    });
    const delta = makeMdpResponse({
      nodes: [
        { id: "a:1", criteria: [{ id: "a", passed: true }], visits: 1 },
      ],
      episodeCount: 1,
    });

    const merged = mergeMdpResponses(existing, delta);
    expect(merged.nodes.length).toBe(2);
    expect(merged.nodes.find((n) => n.id === "a:1")).toBeDefined();
  });

  it("sums edge counts and recomputes probabilities", () => {
    const existing = makeMdpResponse({
      nodes: [
        { id: "s", criteria: [], visits: 2, isInitial: true },
        { id: "a", criteria: [], visits: 2 },
      ],
      edges: [
        { source: "s", target: "a", count: 2, probability: 1.0 },
      ],
      episodeCount: 2,
    });
    const delta = makeMdpResponse({
      nodes: [
        { id: "s", criteria: [], visits: 1, isInitial: true },
        { id: "b", criteria: [], visits: 1 },
      ],
      edges: [
        { source: "s", target: "b", count: 1, probability: 1.0 },
      ],
      episodeCount: 1,
    });

    const merged = mergeMdpResponses(existing, delta);

    // Edge s→a: count=2, probability = 2/3
    const sToA = merged.edges.find((e) => e.source === "s" && e.target === "a");
    expect(sToA).toBeDefined();
    expect(sToA!.count).toBe(2);
    expect(sToA!.probability).toBeCloseTo(2 / 3);

    // Edge s→b: count=1, probability = 1/3
    const sToB = merged.edges.find((e) => e.source === "s" && e.target === "b");
    expect(sToB).toBeDefined();
    expect(sToB!.count).toBe(1);
    expect(sToB!.probability).toBeCloseTo(1 / 3);
  });

  it("preserves isInitial flag from either side", () => {
    const existing = makeMdpResponse({
      nodes: [
        { id: "x", criteria: [], visits: 1 },
      ],
      episodeCount: 1,
    });
    const delta = makeMdpResponse({
      nodes: [
        { id: "x", criteria: [], visits: 1, isInitial: true },
      ],
      episodeCount: 1,
    });

    const merged = mergeMdpResponses(existing, delta);
    expect(merged.nodes.find((n) => n.id === "x")!.isInitial).toBe(true);
  });

  it("recomputes isTerminal after merge", () => {
    const existing = makeMdpResponse({
      nodes: [
        { id: "s", criteria: [], visits: 1, isInitial: true },
        { id: "t", criteria: [], visits: 1, isTerminal: true },
      ],
      edges: [
        { source: "s", target: "t", count: 1, probability: 1.0 },
      ],
      episodeCount: 1,
    });
    // Delta adds an outgoing edge from "t"
    const delta = makeMdpResponse({
      nodes: [
        { id: "t", criteria: [], visits: 1 },
        { id: "u", criteria: [], visits: 1 },
      ],
      edges: [
        { source: "t", target: "u", count: 1, probability: 1.0 },
      ],
      episodeCount: 1,
    });

    const merged = mergeMdpResponses(existing, delta);
    // "t" should no longer be terminal since it now has an outgoing edge
    expect(merged.nodes.find((n) => n.id === "t")!.isTerminal).toBe(false);
    // "u" should be terminal
    expect(merged.nodes.find((n) => n.id === "u")!.isTerminal).toBe(true);
  });

  it("merges availableCriteria from both sides", () => {
    const existing = makeMdpResponse({
      availableCriteria: ["a", "b"],
    });
    const delta = makeMdpResponse({
      availableCriteria: ["b", "c"],
      episodeCount: 1, // Must be > 0 to trigger full merge
      nodes: [{ id: "x", criteria: [], visits: 1 }],
    });

    const merged = mergeMdpResponses(existing, delta);
    expect(merged.availableCriteria).toEqual(["a", "b", "c"]);
  });
});

describe("topologyHash", () => {
  it("returns same hash for same topology", () => {
    const data1 = makeMdpResponse({
      nodes: [
        { id: "a", criteria: [], visits: 1 },
        { id: "b", criteria: [], visits: 5 },
      ],
      edges: [{ source: "a", target: "b", count: 1, probability: 1.0 }],
    });
    const data2 = makeMdpResponse({
      nodes: [
        { id: "b", criteria: [], visits: 10 }, // Different order & visits
        { id: "a", criteria: [], visits: 2 },
      ],
      edges: [{ source: "a", target: "b", count: 3, probability: 1.0 }], // Different count
    });

    expect(topologyHash(data1)).toBe(topologyHash(data2));
  });

  it("returns different hash when nodes change", () => {
    const data1 = makeMdpResponse({
      nodes: [{ id: "a", criteria: [], visits: 1 }],
      edges: [],
    });
    const data2 = makeMdpResponse({
      nodes: [
        { id: "a", criteria: [], visits: 1 },
        { id: "b", criteria: [], visits: 1 },
      ],
      edges: [],
    });

    expect(topologyHash(data1)).not.toBe(topologyHash(data2));
  });

  it("returns different hash when edges change", () => {
    const data1 = makeMdpResponse({
      nodes: [
        { id: "a", criteria: [], visits: 1 },
        { id: "b", criteria: [], visits: 1 },
      ],
      edges: [{ source: "a", target: "b", count: 1, probability: 1.0 }],
    });
    const data2 = makeMdpResponse({
      nodes: [
        { id: "a", criteria: [], visits: 1 },
        { id: "b", criteria: [], visits: 1 },
      ],
      edges: [{ source: "b", target: "a", count: 1, probability: 1.0 }],
    });

    expect(topologyHash(data1)).not.toBe(topologyHash(data2));
  });
});
