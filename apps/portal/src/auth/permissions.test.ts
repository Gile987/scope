// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { hasPermission, isPermission, type Permission } from "./permissions";

describe("Portal permission helpers", () => {
  it("supports resource wildcards and admin action subsumption", () => {
    const permissions: Permission[] = ["scope/*:admin"];

    expect(hasPermission(permissions, "scope/run:read")).toBe(true);
    expect(hasPermission(permissions, "scope/criteria:write")).toBe(true);
  });

  it("does not allow cross-resource or action upgrades", () => {
    expect(hasPermission(["scope/criteria:admin"], "scope/run:write")).toBe(false);
    expect(hasPermission(["scope/run:read"], "scope/run:write")).toBe(false);
  });

  it("never satisfies permissions from an empty set", () => {
    expect(hasPermission([], "scope/run:read")).toBe(false);
  });

  it("validates permission strings", () => {
    expect(isPermission("scope/run:read")).toBe(true);
    expect(isPermission("scope/run:execute")).toBe(false);
    expect(isPermission("scope:read")).toBe(false);
    expect(isPermission("scope/run/details:read")).toBe(false);
    expect(isPermission("scope/run:read:admin")).toBe(false);
  });
});
