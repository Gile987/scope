// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseTOTPSecret, generateTOTP } from "./totp.js";

describe("parseTOTPSecret", () => {
  it("parses a bare base32 secret", () => {
    const result = parseTOTPSecret("JBSWY3DPEHPK3PXP");
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(result.issuer).toBeUndefined();
    expect(result.label).toBeUndefined();
  });

  it("trims whitespace from bare secrets", () => {
    const result = parseTOTPSecret("  JBSWY3DPEHPK3PXP  \n");
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("parses a full otpauth:// URI", () => {
    const uri =
      "otpauth://totp/GitHub:myuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    const result = parseTOTPSecret(uri);
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(result.issuer).toBe("GitHub");
  });

  it("parses URI without issuer", () => {
    const uri = "otpauth://totp/myuser?secret=JBSWY3DPEHPK3PXP";
    const result = parseTOTPSecret(uri);
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(result.issuer).toBeUndefined();
  });

  it("is case-insensitive for the URI scheme", () => {
    const uri =
      "OTPAUTH://totp/GitHub:myuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    const result = parseTOTPSecret(uri);
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
  });
});

describe("generateTOTP", () => {
  it("returns a 6-digit string", () => {
    const code = generateTOTP("JBSWY3DPEHPK3PXP");
    expect(code).toMatch(/^\d{6}$/);
  });

  it("returns consistent results for the same secret within a 30s window", () => {
    const code1 = generateTOTP("JBSWY3DPEHPK3PXP");
    const code2 = generateTOTP("JBSWY3DPEHPK3PXP");
    expect(code1).toBe(code2);
  });

  it("returns different codes for different secrets", () => {
    // These will almost certainly differ (different secrets → different HMAC)
    const code1 = generateTOTP("JBSWY3DPEHPK3PXP");
    const code2 = generateTOTP("HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ");
    // Very small chance of collision, but acceptable for a test
    expect(code1 === code2).toBe(false);
  });
});
