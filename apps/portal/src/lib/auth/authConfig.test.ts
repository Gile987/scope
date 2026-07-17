// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { resolveAuthEnabled } from "./authConfig";

// The auth feature is ON by default (secure by default) with three independent
// per-environment controls:
//  - local dev      -> VITE_AUTH_ENABLED_LOCAL (build-time)
//  - integration    -> SCOPE_AUTH_ENABLED (runtime, __SCOPE_CONFIG__.authEnabled)
//  - production      -> SCOPE_AUTH_ENABLED (runtime, __SCOPE_CONFIG__.authEnabled)
// Resolution: runtime (int/prod) wins; else local vite flag (dev); else default.
function env(overrides: Record<string, string | undefined>): ImportMetaEnv {
  return overrides as unknown as ImportMetaEnv;
}
function runtime(
  overrides: Partial<ScopeRuntimeConfig> | undefined,
): ScopeRuntimeConfig | undefined {
  return overrides as ScopeRuntimeConfig | undefined;
}

describe("resolveAuthEnabled", () => {
  it("is enabled by default (no runtime config, no local flag) everywhere", () => {
    expect(resolveAuthEnabled(undefined, env({}), true)).toBe(true);
    expect(resolveAuthEnabled(undefined, env({}), false)).toBe(true);
  });

  it("runtime authEnabled governs integration/production (built bundle)", () => {
    expect(
      resolveAuthEnabled(runtime({ authEnabled: false }), env({}), false),
    ).toBe(false);
    expect(
      resolveAuthEnabled(runtime({ authEnabled: true }), env({}), false),
    ).toBe(true);
  });

  it("runtime authEnabled wins over the local vite flag even in dev", () => {
    expect(
      resolveAuthEnabled(
        runtime({ authEnabled: false }),
        env({ VITE_AUTH_ENABLED_LOCAL: "true" }),
        true,
      ),
    ).toBe(false);
  });

  it("local VITE_AUTH_ENABLED_LOCAL controls local dev only", () => {
    expect(
      resolveAuthEnabled(undefined, env({ VITE_AUTH_ENABLED_LOCAL: "false" }), true),
    ).toBe(false);
    // Built bundle ignores the local flag; with no runtime config it falls back
    // to the secure default.
    expect(
      resolveAuthEnabled(undefined, env({ VITE_AUTH_ENABLED_LOCAL: "false" }), false),
    ).toBe(true);
  });

  it("accepts a string runtime value and common spellings", () => {
    for (const v of ["false", "0", "no", "off", "FALSE", " false "]) {
      expect(
        resolveAuthEnabled(runtime({ authEnabled: v as never }), env({}), false),
      ).toBe(false);
    }
    for (const v of ["true", "1", "yes", "on"]) {
      expect(
        resolveAuthEnabled(runtime({ authEnabled: v as never }), env({}), false),
      ).toBe(true);
    }
  });

  it("local flag fails safe to enabled on a nonsense value", () => {
    expect(
      resolveAuthEnabled(undefined, env({ VITE_AUTH_ENABLED_LOCAL: "maybe" }), true),
    ).toBe(true);
  });
});
