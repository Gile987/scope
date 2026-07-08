// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import {
  majority,
  countMatches,
  isMajority,
  collectSampledGrades,
} from "./sampling.js";

describe("majority", () => {
  it("is a strict majority (more than half)", () => {
    expect(majority(1)).toBe(1);
    expect(majority(3)).toBe(2);
    expect(majority(5)).toBe(3);
    expect(majority(4)).toBe(3); // even N: a 2-2 tie is not a majority
  });
});

describe("countMatches / isMajority", () => {
  it("counts matching labels", () => {
    expect(countMatches(["a", "b", "a"], "a")).toBe(2);
    expect(countMatches<string>([], "a")).toBe(0);
  });

  it("detects a strict majority", () => {
    expect(isMajority(["a", "a", "b"], "a")).toBe(true);
    expect(isMajority(["a", "b", "c"], "a")).toBe(false);
    expect(isMajority(["a", "b"], "a")).toBe(false); // 1 of 2 is not a majority
    expect(isMajority(["a", "a"], "a")).toBe(true);
  });
});

describe("collectSampledGrades", () => {
  it("generates then grades N times, returning grades in order", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce("p0")
      .mockResolvedValueOnce("p1")
      .mockResolvedValueOnce("p2");
    const grade = vi.fn(async (artifact: string) => `graded:${artifact}`);

    const grades = await collectSampledGrades({
      samples: 3,
      generate,
      grade,
      spacingMs: 0,
      gradeSpacingMs: 0,
    });

    expect(grades).toEqual(["graded:p0", "graded:p1", "graded:p2"]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(grade).toHaveBeenCalledTimes(3);
    expect(grade).toHaveBeenNthCalledWith(1, "p0");
    expect(grade).toHaveBeenNthCalledWith(3, "p2");
  });

  it("calls generate before grade for every sample and preserves order", async () => {
    const order: string[] = [];
    const grades = await collectSampledGrades<string>({
      samples: 2,
      generate: async () => {
        order.push("generate");
        return "p";
      },
      grade: async () => {
        order.push("grade");
        return "g";
      },
      spacingMs: 0,
      gradeSpacingMs: 0,
    });

    expect(grades).toEqual(["g", "g"]);
    expect(order).toEqual(["generate", "grade", "generate", "grade"]);
  });
});
