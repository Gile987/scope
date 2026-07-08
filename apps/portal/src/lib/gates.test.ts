// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { GATE_FEATURE_FLAGS, visibleGateOrder } from "./gates";

describe("visibleGateOrder", () => {
  it("hides flag-gated gates when no flags are enabled (fail-closed)", () => {
    expect(visibleGateOrder({})).toEqual(["select", "build", "test"]);
  });

  it("shows run only when gates-run is explicitly true", () => {
    expect(visibleGateOrder({ "gates-run": true })).toEqual([
      "select",
      "build",
      "test",
      "run",
    ]);
  });

  it("shows deploy only when gates-deploy is explicitly true", () => {
    expect(visibleGateOrder({ "gates-deploy": true })).toEqual([
      "select",
      "build",
      "test",
      "deploy",
    ]);
  });

  it("shows all gates in order when both flags are enabled", () => {
    expect(
      visibleGateOrder({ "gates-run": true, "gates-deploy": true }),
    ).toEqual(["select", "build", "test", "run", "deploy"]);
  });

  it("treats a flag explicitly set to false as hidden", () => {
    expect(
      visibleGateOrder({ "gates-run": false, "gates-deploy": true }),
    ).toEqual(["select", "build", "test", "deploy"]);
  });

  it("maps run/deploy to their feature-flag keys", () => {
    expect(GATE_FEATURE_FLAGS).toEqual({
      run: "gates-run",
      deploy: "gates-deploy",
    });
  });
});
