// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildGateIterationScoper } from "./gates";

describe("buildGateIterationScoper", () => {
  it("restarts iteration numbering at 1 for each gate", () => {
    // Globally-unique iterations across three sequential gates.
    const items = [
      { gate: "select" as const, iteration: 1 },
      { gate: "build" as const, iteration: 2 },
      { gate: "build" as const, iteration: 3 },
      { gate: "test" as const, iteration: 4 },
    ];
    const scope = buildGateIterationScoper(items);
    expect(scope("select", 1)).toBe(1);
    expect(scope("build", 2)).toBe(1);
    expect(scope("build", 3)).toBe(2);
    expect(scope("test", 4)).toBe(1);
  });

  it("treats items without a gate as the select gate", () => {
    const items = [
      { iteration: 1 },
      { iteration: 2 },
      { iteration: 3 },
    ];
    const scope = buildGateIterationScoper(items);
    // Legacy single-gate runs are unaffected: scoped === global.
    expect(scope(undefined, 1)).toBe(1);
    expect(scope(undefined, 2)).toBe(2);
    expect(scope(undefined, 3)).toBe(3);
  });

  it("is order-independent and ignores null iterations", () => {
    const items = [
      { gate: "build" as const, iteration: 3 },
      { gate: "build" as const, iteration: null },
      { gate: "build" as const, iteration: 2 },
    ];
    const scope = buildGateIterationScoper(items);
    expect(scope("build", 2)).toBe(1);
    expect(scope("build", 3)).toBe(2);
  });

  it("falls back to the global number for gates it has never seen", () => {
    const scope = buildGateIterationScoper([{ gate: "select" as const, iteration: 1 }]);
    expect(scope("deploy", 7)).toBe(7);
  });
});
