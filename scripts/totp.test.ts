// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { createTOTP, getTOTPInfo } from "./totp.js";

describe("createTOTP", () => {
  it("creates TOTP from bare base32 secret with defaults", () => {
    const totp = createTOTP("JBSWY3DPEHPK3PXP");
    const info = getTOTPInfo(totp);
    expect(info.algorithm).toBe("SHA1");
    expect(info.digits).toBe(6);
    expect(info.period).toBe(30);
  });

  it("trims whitespace from bare secrets", () => {
    const totp = createTOTP("  JBSWY3DPEHPK3PXP  \n");
    expect(totp.generate()).toMatch(/^\d{6}$/);
  });

  it("parses a full otpauth:// URI with all params", () => {
    const uri =
      "otpauth://totp/GitHub:myuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60";
    const totp = createTOTP(uri);
    const info = getTOTPInfo(totp);
    expect(info.issuer).toBe("GitHub");
    expect(info.algorithm).toBe("SHA256");
    expect(info.digits).toBe(8);
    expect(info.period).toBe(60);
  });

  it("parses URI without issuer", () => {
    const uri = "otpauth://totp/myuser?secret=JBSWY3DPEHPK3PXP";
    const info = getTOTPInfo(createTOTP(uri));
    expect(info.issuer).toBeUndefined();
  });

  it("is case-insensitive for the URI scheme", () => {
    const uri =
      "OTPAUTH://totp/GitHub:myuser?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    const totp = createTOTP(uri);
    expect(totp.generate()).toMatch(/^\d{6}$/);
  });

  it("URI and bare secret produce same codes for same secret", () => {
    const fromUri = createTOTP("otpauth://totp/Test:user?secret=JBSWY3DPEHPK3PXP");
    const fromBare = createTOTP("JBSWY3DPEHPK3PXP");
    expect(fromUri.generate()).toBe(fromBare.generate());
  });
});

describe("generate", () => {
  it("returns a 6-digit string", () => {
    const code = createTOTP("JBSWY3DPEHPK3PXP").generate();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("returns consistent results within a 30s window", () => {
    const totp = createTOTP("JBSWY3DPEHPK3PXP");
    expect(totp.generate()).toBe(totp.generate());
  });

  it("returns different codes for different secrets", () => {
    const code1 = createTOTP("JBSWY3DPEHPK3PXP").generate();
    const code2 = createTOTP("HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ").generate();
    expect(code1 === code2).toBe(false);
  });

  it("respects custom digits from URI", () => {
    const totp = createTOTP("otpauth://totp/Test:user?secret=JBSWY3DPEHPK3PXP&digits=8");
    expect(totp.generate()).toMatch(/^\d{8}$/);
  });
});
