// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { applyApiPortFallback } from "./shared.js";

describe("applyApiPortFallback", () => {
  it("sets SCOPE_API_URL from SCOPE_API_PORT when SCOPE_API_URL is unset", () => {
    const env: NodeJS.ProcessEnv = { SCOPE_API_PORT: "5108" };
    applyApiPortFallback(env);
    expect(env.SCOPE_API_URL).toBe("http://localhost:5108");
  });

  it("does not override an already-set SCOPE_API_URL", () => {
    const env: NodeJS.ProcessEnv = {
      SCOPE_API_URL: "https://api.example.com",
      SCOPE_API_PORT: "5108",
    };
    applyApiPortFallback(env);
    expect(env.SCOPE_API_URL).toBe("https://api.example.com");
  });

  it("is a no-op when SCOPE_API_PORT is unset", () => {
    const env: NodeJS.ProcessEnv = {};
    applyApiPortFallback(env);
    expect(env.SCOPE_API_URL).toBeUndefined();
  });

  it("trims whitespace around a numeric SCOPE_API_PORT", () => {
    const env: NodeJS.ProcessEnv = { SCOPE_API_PORT: "  3200  " };
    applyApiPortFallback(env);
    expect(env.SCOPE_API_URL).toBe("http://localhost:3200");
  });

  it("ignores non-numeric SCOPE_API_PORT values rather than producing an unreachable URL", () => {
    const env: NodeJS.ProcessEnv = { SCOPE_API_PORT: "not-a-port" };
    applyApiPortFallback(env);
    expect(env.SCOPE_API_URL).toBeUndefined();
  });
});
