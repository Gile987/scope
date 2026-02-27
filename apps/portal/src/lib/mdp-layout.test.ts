// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { estimateNodeWidth } from "./mdp-layout";

// Minimal stub types matching MdpNodeData shape
function makeNodeData(overrides: {
  criteria?: { id: string; passed: boolean }[];
  features?: { id: string; detected: boolean }[];
  nodeType?: string;
}) {
  return {
    criteria: overrides.criteria ?? [],
    features: overrides.features,
    nodeType: overrides.nodeType,
    visits: 1,
    passedCount: 0,
    totalCount: overrides.criteria?.length ?? 0,
  } as Parameters<typeof estimateNodeWidth>[0];
}

describe("estimateNodeWidth", () => {
  it("returns NODE_MIN_WIDTH for a node with no labels", () => {
    const data = makeNodeData({ criteria: [] });
    expect(estimateNodeWidth(data)).toBe(180);
  });

  it("returns NODE_MIN_WIDTH for short criteria labels", () => {
    const data = makeNodeData({
      criteria: [
        { id: "ok", passed: true },
        { id: "no", passed: false },
      ],
    });
    // "ok" → 2 chars * 6.5 + 50 = 63 → clamped to 180
    expect(estimateNodeWidth(data)).toBe(180);
  });

  it("returns wider than NODE_MIN_WIDTH for long criteria labels", () => {
    const data = makeNodeData({
      criteria: [
        { id: "asks_for_serverless_architecture", passed: false },
        { id: "has_iac", passed: true },
      ],
    });
    const width = estimateNodeWidth(data);
    // "asks_for_serverless_architecture" = 32 chars → 32*6.5 + 50 = 258
    expect(width).toBeGreaterThan(180);
    expect(width).toBe(Math.ceil(32 * 6.5 + 50));
  });

  it("uses feature labels for feature nodes", () => {
    const data = makeNodeData({
      nodeType: "prompt-features",
      features: [
        { id: "requires_vector_database_for_embeddings", detected: true },
        { id: "asks_for_go_lang", detected: false },
      ],
    });
    const width = estimateNodeWidth(data);
    // longest: "requires_vector_database_for_embeddings" = 39 chars
    expect(width).toBeGreaterThan(180);
    expect(width).toBe(Math.ceil(39 * 6.5 + 50));
  });

  it("accounts for the header text on unknown feature nodes", () => {
    const data = makeNodeData({
      nodeType: "prompt-features",
      features: [],
    });
    const width = estimateNodeWidth(data);
    // header "No features extracted" = 21 chars → 21*6.5+50 = 186.5 → ceil → 187
    expect(width).toBe(Math.ceil(21 * 6.5 + 50));
    expect(width).toBeGreaterThan(180);
  });

  it("always returns at least NODE_MIN_WIDTH", () => {
    const data = makeNodeData({
      criteria: [{ id: "a", passed: true }],
    });
    expect(estimateNodeWidth(data)).toBe(180);
  });
});
