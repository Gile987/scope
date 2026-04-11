// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { formatStatRange } from "./grouping";

describe("formatStatRange", () => {
  it("returns dash for null stats", () => {
    expect(formatStatRange(null)).toBe("–");
  });

  it("returns single value when min equals max", () => {
    expect(formatStatRange({ min: 5, max: 5, mean: 5, stdDev: 0 })).toBe("5");
  });

  it("returns range with mean and stddev", () => {
    const result = formatStatRange({ min: 2, max: 10, mean: 6, stdDev: 2.5 });
    expect(result).toContain("2");
    expect(result).toContain("10");
    expect(result).toContain("μ6");
    expect(result).toContain("σ2.5");
  });

  it("uses custom formatter", () => {
    const fmt = (v: number) => `${v}ms`;
    const result = formatStatRange({ min: 100, max: 200, mean: 150, stdDev: 30 }, fmt);
    expect(result).toContain("100ms");
    expect(result).toContain("200ms");
  });
});
