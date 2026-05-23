// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  normalizeDependsOn,
  ensureNoSelfReference,
  ensureDependenciesExist,
  ensureAcyclicCriteria,
} from "./criteria-validation.js";

describe("normalizeDependsOn", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeDependsOn(undefined)).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(normalizeDependsOn(null)).toEqual([]);
  });

  it("returns empty array for non-array types", () => {
    expect(normalizeDependsOn("not-an-array")).toEqual([]);
    expect(normalizeDependsOn(42)).toEqual([]);
    expect(normalizeDependsOn({})).toEqual([]);
  });

  it("converts numeric elements to strings", () => {
    expect(normalizeDependsOn([1, 2])).toEqual(["1", "2"]);
  });

  it("trims whitespace from elements", () => {
    expect(normalizeDependsOn(["  a ", " b"])).toEqual(["a", "b"]);
  });

  it("filters out empty strings after trimming", () => {
    expect(normalizeDependsOn(["a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("handles mixed types in array", () => {
    expect(normalizeDependsOn(["a", 0, null, "b"])).toEqual(["a", "0", "null", "b"]);
  });

  it("returns empty array for empty array input", () => {
    expect(normalizeDependsOn([])).toEqual([]);
  });

  it("passes through clean string arrays unchanged", () => {
    expect(normalizeDependsOn(["x", "y", "z"])).toEqual(["x", "y", "z"]);
  });
});

describe("ensureNoSelfReference", () => {
  it("does nothing when dependsOn does not include id", () => {
    expect(() => ensureNoSelfReference("a", ["b", "c"])).not.toThrow();
  });

  it("does nothing for empty dependsOn", () => {
    expect(() => ensureNoSelfReference("a", [])).not.toThrow();
  });

  it("throws when id appears in dependsOn", () => {
    expect(() => ensureNoSelfReference("a", ["b", "a"])).toThrow(
      "A criterion cannot depend on itself",
    );
  });

  it("throws when id is the only dependency", () => {
    expect(() => ensureNoSelfReference("x", ["x"])).toThrow(
      "A criterion cannot depend on itself",
    );
  });
});

describe("ensureDependenciesExist", () => {
  it("does nothing when all dependencies exist", () => {
    const available = new Set(["a", "b", "c"]);
    expect(() => ensureDependenciesExist(["a", "b"], available)).not.toThrow();
  });

  it("does nothing for empty dependsOn", () => {
    expect(() => ensureDependenciesExist([], new Set())).not.toThrow();
  });

  it("throws for the first missing dependency", () => {
    const available = new Set(["a"]);
    expect(() => ensureDependenciesExist(["a", "missing"], available)).toThrow(
      "Dependency 'missing' does not exist",
    );
  });

  it("throws when none of the dependencies exist", () => {
    expect(() => ensureDependenciesExist(["x"], new Set())).toThrow(
      "Dependency 'x' does not exist",
    );
  });
});

describe("ensureAcyclicCriteria", () => {
  it("accepts a valid DAG", () => {
    expect(() =>
      ensureAcyclicCriteria([
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a", "b"] },
      ]),
    ).not.toThrow();
  });

  it("accepts nodes with no dependencies", () => {
    expect(() =>
      ensureAcyclicCriteria([
        { id: "x", dependsOn: [] },
        { id: "y", dependsOn: [] },
      ]),
    ).not.toThrow();
  });

  it("accepts a single node", () => {
    expect(() =>
      ensureAcyclicCriteria([{ id: "solo", dependsOn: [] }]),
    ).not.toThrow();
  });

  it("accepts empty array", () => {
    expect(() => ensureAcyclicCriteria([])).not.toThrow();
  });

  it("detects a 2-node cycle", () => {
    expect(() =>
      ensureAcyclicCriteria([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).toThrow("Cycle detected in dependencies");
  });

  it("detects a 3-node cycle", () => {
    expect(() =>
      ensureAcyclicCriteria([
        { id: "a", dependsOn: ["c"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]),
    ).toThrow("Cycle detected in dependencies");
  });

  it("detects a cycle even with valid nodes present", () => {
    expect(() =>
      ensureAcyclicCriteria([
        { id: "root", dependsOn: [] },
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).toThrow("Cycle detected in dependencies");
  });

  it("handles undefined dependsOn as empty", () => {
    expect(() =>
      ensureAcyclicCriteria([
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).not.toThrow();
  });
});
