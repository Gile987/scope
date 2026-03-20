// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { normalizeCriteria } from "./normalize-criteria.js";
import type { CriteriaConfig } from "../types/types.js";

describe("normalizeCriteria", () => {
  it("returns empty array for empty input", () => {
    expect(normalizeCriteria([])).toEqual([]);
  });

  describe("v1 format (string[])", () => {
    it("converts a single string to CriteriaConfig with id 'criterion-1'", () => {
      const result = normalizeCriteria(["Check code quality"]);
      expect(result).toEqual([
        { id: "criterion-1", prompt: "Check code quality", dependsOn: [] },
      ]);
    });

    it("converts multiple strings with sequential ids", () => {
      const result = normalizeCriteria(["First", "Second", "Third"]);
      expect(result).toEqual([
        { id: "criterion-1", prompt: "First", dependsOn: [] },
        { id: "criterion-2", prompt: "Second", dependsOn: [] },
        { id: "criterion-3", prompt: "Third", dependsOn: [] },
      ]);
    });

    it("trims whitespace from string prompts", () => {
      const result = normalizeCriteria(["  leading spaces", "trailing spaces  ", "  both  "]);
      expect(result[0].prompt).toBe("leading spaces");
      expect(result[1].prompt).toBe("trailing spaces");
      expect(result[2].prompt).toBe("both");
    });

    it("sets dependsOn to empty array for all converted entries", () => {
      const result = normalizeCriteria(["A", "B"]);
      expect(result[0].dependsOn).toEqual([]);
      expect(result[1].dependsOn).toEqual([]);
    });
  });

  describe("v2 format (CriteriaConfig[])", () => {
    it("returns as-is when input is already CriteriaConfig[]", () => {
      const configs: CriteriaConfig[] = [
        { id: "my-criterion", prompt: "Check coverage", dependsOn: [] },
      ];
      const result = normalizeCriteria(configs);
      expect(result).toBe(configs);
    });

    it("preserves dependsOn relationships in v2 format", () => {
      const configs: CriteriaConfig[] = [
        { id: "parent", prompt: "Parent check", dependsOn: [] },
        { id: "child", prompt: "Child check", dependsOn: ["parent"] },
      ];
      const result = normalizeCriteria(configs);
      expect(result).toBe(configs);
      expect(result[1].dependsOn).toEqual(["parent"]);
    });

    it("preserves custom ids in v2 format", () => {
      const configs: CriteriaConfig[] = [
        { id: "custom-id-42", prompt: "Custom criterion", dependsOn: [] },
      ];
      const result = normalizeCriteria(configs);
      expect(result[0].id).toBe("custom-id-42");
    });

    it("detects v2 format by checking first element has an 'id' property", () => {
      const configs: CriteriaConfig[] = [
        { id: "check", prompt: "Some check", dependsOn: [] },
        { id: "check-2", prompt: "Another check", dependsOn: [] },
      ];
      const result = normalizeCriteria(configs);
      expect(result).toBe(configs);
    });
  });
});
