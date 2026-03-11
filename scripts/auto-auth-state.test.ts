// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { resolveOptions } from "./auto-auth-state.js";

describe("resolveOptions", () => {
  const baseEnv = {
    GITHUB_USERNAME: "envuser",
    GITHUB_PASSWORD: "envpass",
    GITHUB_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  };

  it("reads all values from CLI flags", () => {
    const opts = resolveOptions(
      [
        "node",
        "script.ts",
        "--username",
        "cliuser",
        "--password",
        "clipass",
        "--totp-secret",
        "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ",
      ],
      {}
    );
    expect(opts.username).toBe("cliuser");
    expect(opts.password).toBe("clipass");
    expect(opts.totpSecret).toBe("HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ");
    expect(opts.headed).toBe(false);
  });

  it("falls back to env vars when CLI flags are absent", () => {
    const opts = resolveOptions(["node", "script.ts"], baseEnv);
    expect(opts.username).toBe("envuser");
    expect(opts.password).toBe("envpass");
    expect(opts.totpSecret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("CLI flags take precedence over env vars", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--username", "cliuser", "--password", "clipass", "--totp-secret", "CLISECRET"],
      baseEnv
    );
    expect(opts.username).toBe("cliuser");
    expect(opts.password).toBe("clipass");
    expect(opts.totpSecret).toBe("CLISECRET");
  });

  it("sets output to default when not specified", () => {
    const opts = resolveOptions(["node", "script.ts"], baseEnv);
    expect(opts.output).toBe(".auth/github-storage.json");
  });

  it("accepts custom --output", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--output", "/tmp/custom.json"],
      baseEnv
    );
    expect(opts.output).toBe("/tmp/custom.json");
  });

  it("detects --headed flag", () => {
    const opts = resolveOptions(["node", "script.ts", "--headed"], baseEnv);
    expect(opts.headed).toBe(true);
  });

  it("throws when username is missing", () => {
    expect(() =>
      resolveOptions(["node", "script.ts"], {
        GITHUB_PASSWORD: "pass",
        GITHUB_TOTP_SECRET: "secret",
      })
    ).toThrow("Missing --username or GITHUB_USERNAME");
  });

  it("throws when password is missing", () => {
    expect(() =>
      resolveOptions(["node", "script.ts"], {
        GITHUB_USERNAME: "user",
        GITHUB_TOTP_SECRET: "secret",
      })
    ).toThrow("Missing --password or GITHUB_PASSWORD");
  });

  it("throws when totp-secret is missing", () => {
    expect(() =>
      resolveOptions(["node", "script.ts"], {
        GITHUB_USERNAME: "user",
        GITHUB_PASSWORD: "pass",
      })
    ).toThrow("Missing --totp-secret or GITHUB_TOTP_SECRET");
  });

  it("detects --totp-only flag", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--totp-only", "--totp-secret", "JBSWY3DPEHPK3PXP"],
      {}
    );
    expect(opts.totpOnly).toBe(true);
  });

  it("does not require username/password in --totp-only mode", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--totp-only", "--totp-secret", "JBSWY3DPEHPK3PXP"],
      {}
    );
    expect(opts.totpSecret).toBe("JBSWY3DPEHPK3PXP");
    expect(opts.username).toBe("");
    expect(opts.password).toBe("");
  });

  it("still throws when totp-secret is missing in --totp-only mode", () => {
    expect(() =>
      resolveOptions(["node", "script.ts", "--totp-only"], {})
    ).toThrow("Missing --totp-secret or GITHUB_TOTP_SECRET");
  });
});
