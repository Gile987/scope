// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseTOTPSecret, generateTOTP } from "./totp.js";

describe("parseTOTPSecret", () => {
  it("parses a bare base32 secret with defaults", () => {
    const result = parseTOTPSecret("JBSWY3DPEHPK3PXP");
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(result.algorithm).toBe("SHA1");
    expect(result.digits).toBe(6);
    expect(result.period).toBe(30);
    expect(result.issuer).toBeUndefined();
    expect(result.label).toBeUndefined();
  });

  it("trims whitespace from bare secrets", () => {
    const result = parseTOTPSecret("  JBSWY3DPEHPK3PXP  \n");
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("parses a full otpauth:// URI with all params", () => {
    const uri =
      "otpauth://totp/GitHub:myuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60";
    const result = parseTOTPSecret(uri);
    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(result.issuer).toBe("GitHub");
    expect(result.algorithm).toBe("SHA256");
    expect(result.digits).toBe(8);
    expect(result.period).toBe(60);
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
  const defaultParams = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 };

  it("returns a 6-digit string", () => {
    const code = generateTOTP(defaultParams);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("returns consistent results for the same params within a 30s window", () => {
    const code1 = generateTOTP(defaultParams);
    const code2 = generateTOTP(defaultParams);
    expect(code1).toBe(code2);
  });

  it("returns different codes for different secrets", () => {
    const code1 = generateTOTP(defaultParams);
    const code2 = generateTOTP({ ...defaultParams, secret: "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ" });
    expect(code1 === code2).toBe(false);
  });

  it("respects custom digits parameter", () => {
    const code = generateTOTP({ ...defaultParams, digits: 8 });
    expect(code).toMatch(/^\d{8}$/);
  });
});
