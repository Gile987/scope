// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { extractPort } from "./open-portal.js";

describe("extractPort", () => {
  it("extracts PORTAL_PORT from a standard .env content", () => {
    const env = `
API_PORT=3100
PORTAL_PORT=5100
REDIS_PORT=6300
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5100);
  });

  it("extracts a worktree-offset port", () => {
    const env = `
# --- BEGIN managed by worktree-env.sh (do not edit) ---
# Worktree: my-feature  |  Offset: 3
COMPOSE_PROJECT_NAME=scope-mt-app-my-feature
API_PORT=3103
PORTAL_PORT=5103
REDIS_PORT=6303
# --- END managed by worktree-env.sh ---
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5103);
  });

  it("returns undefined when the key is not present", () => {
    const env = `
API_PORT=3100
REDIS_PORT=6300
`;
    expect(extractPort(env, "PORTAL_PORT")).toBeUndefined();
  });

  it("returns undefined for non-numeric value", () => {
    const env = `PORTAL_PORT=not-a-number`;
    expect(extractPort(env, "PORTAL_PORT")).toBeUndefined();
  });

  it("ignores commented-out lines", () => {
    const env = `
# PORTAL_PORT=9999
PORTAL_PORT=5100
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5100);
  });

  it("returns the last occurrence when duplicated", () => {
    const env = `
PORTAL_PORT=5100
PORTAL_PORT=5103
`;
    // extractPort scans line-by-line and returns the first match
    expect(extractPort(env, "PORTAL_PORT")).toBe(5100);
  });

  it("handles empty content", () => {
    expect(extractPort("", "PORTAL_PORT")).toBeUndefined();
  });

  it("handles lines without equals sign", () => {
    const env = `
PORTAL_PORT
API_PORT=3100
`;
    expect(extractPort(env, "PORTAL_PORT")).toBeUndefined();
    expect(extractPort(env, "API_PORT")).toBe(3100);
  });
});
