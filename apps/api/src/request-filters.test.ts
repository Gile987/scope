// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  parseCommaSeparatedIds,
  buildScenarioCriteriaFilter,
  buildPromptFeatureTaskPromptFilter,
} from "./request-filters.js";

// ─── parseCommaSeparatedIds ──────────────────────────────────────────────────

describe("parseCommaSeparatedIds", () => {
  it("parses a single ID", () => {
    expect(parseCommaSeparatedIds("has_azure")).toEqual(["has_azure"]);
  });

  it("parses multiple comma-separated IDs", () => {
    expect(parseCommaSeparatedIds("has_azure,has_cloud,has_node")).toEqual([
      "has_azure",
      "has_cloud",
      "has_node",
    ]);
  });

  it("trims whitespace from IDs", () => {
    expect(parseCommaSeparatedIds(" has_azure , has_cloud ")).toEqual([
      "has_azure",
      "has_cloud",
    ]);
  });

  it("filters out empty segments", () => {
    expect(parseCommaSeparatedIds(",has_azure,,has_cloud,")).toEqual([
      "has_azure",
      "has_cloud",
    ]);
  });

  it("returns empty array for undefined", () => {
    expect(parseCommaSeparatedIds(undefined)).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(parseCommaSeparatedIds(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCommaSeparatedIds("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseCommaSeparatedIds("  ,  , ")).toEqual([]);
  });
});

// ─── buildScenarioCriteriaFilter ─────────────────────────────────────────────

describe("buildScenarioCriteriaFilter", () => {
  it("returns undefined for empty IDs", () => {
    expect(buildScenarioCriteriaFilter([])).toBeUndefined();
  });

  it("builds $all filter for a single criterion", () => {
    expect(buildScenarioCriteriaFilter(["has_azure"])).toEqual({
      "scenario.criteria": { $all: ["has_azure"] },
    });
  });

  it("builds $all filter for multiple criteria", () => {
    expect(buildScenarioCriteriaFilter(["has_azure", "has_cloud"])).toEqual({
      "scenario.criteria": { $all: ["has_azure", "has_cloud"] },
    });
  });
});

// ─── buildPromptFeatureTaskPromptFilter ──────────────────────────────────────

describe("buildPromptFeatureTaskPromptFilter", () => {
  it("returns undefined for empty feature IDs", () => {
    expect(buildPromptFeatureTaskPromptFilter([])).toBeUndefined();
  });

  it("builds $and + $elemMatch filter for a single feature", () => {
    const result = buildPromptFeatureTaskPromptFilter(["asks_for_api"]);
    expect(result).toEqual({
      $and: [
        {
          features: {
            $elemMatch: { featureId: "asks_for_api", detected: true },
          },
        },
      ],
      deletedAt: { $exists: false },
    });
  });

  it("builds $and + $elemMatch filter for multiple features", () => {
    const result = buildPromptFeatureTaskPromptFilter(["asks_for_api", "asks_for_azure"]);
    expect(result).toEqual({
      $and: [
        {
          features: {
            $elemMatch: { featureId: "asks_for_api", detected: true },
          },
        },
        {
          features: {
            $elemMatch: { featureId: "asks_for_azure", detected: true },
          },
        },
      ],
      deletedAt: { $exists: false },
    });
  });
});
