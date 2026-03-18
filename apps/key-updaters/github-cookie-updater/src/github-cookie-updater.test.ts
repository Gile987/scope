// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";

// Mock decodeQRImage before importing resolveOptions
vi.mock("./totp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./totp.js")>();
  return {
    ...actual,
    decodeQRImage: vi.fn(() => "otpauth://totp/GitHub:testuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"),
  };
});

import { resolveOptions } from "./github-cookie-updater.js";
import { decodeQRImage } from "./totp.js";

describe("resolveOptions", () => {
  const baseEnv = {
    GH_AUTH_USERNAME: "envuser",
    GH_AUTH_PASSWORD: "envpass",
    GH_AUTH_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
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
        GH_AUTH_PASSWORD: "pass",
        GH_AUTH_TOTP_SECRET: "secret",
      })
    ).toThrow("Missing --username or GH_AUTH_USERNAME");
  });

  it("throws when password is missing", () => {
    expect(() =>
      resolveOptions(["node", "script.ts"], {
        GH_AUTH_USERNAME: "user",
        GH_AUTH_TOTP_SECRET: "secret",
      })
    ).toThrow("Missing --password or GH_AUTH_PASSWORD");
  });

  it("throws when totp-secret is missing", () => {
    expect(() =>
      resolveOptions(["node", "script.ts"], {
        GH_AUTH_USERNAME: "user",
        GH_AUTH_PASSWORD: "pass",
      })
    ).toThrow("Missing --totp-secret, --qr-code, or GH_AUTH_TOTP_SECRET");
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
    ).toThrow("Missing --totp-secret, --qr-code, or GH_AUTH_TOTP_SECRET");
  });

  it("accepts --qr-code and decodes the image", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--qr-code", "/tmp/qr.png", "--username", "u", "--password", "p"],
      {}
    );
    expect(decodeQRImage).toHaveBeenCalledWith("/tmp/qr.png");
    expect(opts.totpSecret).toBe("otpauth://totp/GitHub:testuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
  });

  it("--qr-code works with --totp-only", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--totp-only", "--qr-code", "/tmp/qr.png"],
      {}
    );
    expect(opts.totpOnly).toBe(true);
    expect(opts.totpSecret).toContain("otpauth://");
  });

  it("--qr-code takes precedence over --totp-secret", () => {
    const opts = resolveOptions(
      ["node", "script.ts", "--qr-code", "/tmp/qr.png", "--totp-secret", "IGNORED", "--username", "u", "--password", "p"],
      {}
    );
    expect(opts.totpSecret).toContain("otpauth://");
  });
});
