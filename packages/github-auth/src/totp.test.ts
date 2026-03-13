// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { createTOTP, getTOTPInfo } from "./totp.js";

describe("createTOTP", () => {
  const BARE_SECRET = "JBSWY3DPEHPK3PXP"; // Standard test base32 secret

  it("creates TOTP from bare base32 secret with defaults", () => {
    const totp = createTOTP(BARE_SECRET);
    expect(totp.digits).toBe(6);
    expect(totp.period).toBe(30);
    expect(totp.algorithm).toBe("SHA1");
    // Should generate a 6-digit code
    const code = totp.generate();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("trims whitespace from input", () => {
    const totp = createTOTP(`  ${BARE_SECRET}  `);
    const code = totp.generate();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("creates TOTP from otpauth:// URI", () => {
    const uri = `otpauth://totp/GitHub:user@example.com?secret=${BARE_SECRET}&issuer=GitHub&algorithm=SHA1&digits=6&period=30`;
    const totp = createTOTP(uri);
    expect(totp.digits).toBe(6);
    expect(totp.issuer).toBe("GitHub");
    expect(totp.generate()).toMatch(/^\d{6}$/);
  });

  it("handles case-insensitive URI scheme", () => {
    const uri = `OTPAUTH://totp/Test?secret=${BARE_SECRET}`;
    const totp = createTOTP(uri);
    expect(totp.generate()).toMatch(/^\d{6}$/);
  });

  it("throws on HOTP URI", () => {
    const uri = `otpauth://hotp/Test?secret=${BARE_SECRET}&counter=0`;
    expect(() => createTOTP(uri)).toThrow("TOTP");
  });
});

describe("getTOTPInfo", () => {
  it("returns algorithm, digits, period from bare secret", () => {
    const totp = createTOTP("JBSWY3DPEHPK3PXP");
    const info = getTOTPInfo(totp);
    expect(info.algorithm).toBe("SHA1");
    expect(info.digits).toBe(6);
    expect(info.period).toBe(30);
    expect(info.issuer).toBeUndefined();
  });

  it("returns issuer and label from URI", () => {
    const uri = "otpauth://totp/GitHub:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    const totp = createTOTP(uri);
    const info = getTOTPInfo(totp);
    expect(info.issuer).toBe("GitHub");
    expect(info.label).toBe("user@example.com");
  });
});
