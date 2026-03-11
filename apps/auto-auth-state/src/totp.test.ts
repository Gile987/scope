// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { createTOTP, getTOTPInfo, decodeQRImage } from "./totp.js";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import encodeQR from "qr";
import { PNG } from "pngjs";

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

describe("decodeQRImage", () => {
  const testDir = join(tmpdir(), "auto-auth-state-test");
  const qrPath = join(testDir, "test-qr.png");

  function writePngFromRaw(rawBits: boolean[][], filePath: string) {
    const height = rawBits.length;
    const width = rawBits[0].length;
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const val = rawBits[y][x] ? 0 : 255; // true = black, false = white
        png.data[idx] = val;
        png.data[idx + 1] = val;
        png.data[idx + 2] = val;
        png.data[idx + 3] = 255;
      }
    }
    writeFileSync(filePath, PNG.sync.write(png));
  }

  it("decodes a QR code image containing an otpauth URI", () => {
    mkdirSync(testDir, { recursive: true });
    const uri = "otpauth://totp/GitHub:user?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    const rawBits = encodeQR(uri, "raw", { scale: 4 });
    writePngFromRaw(rawBits, qrPath);
    try {
      const decoded = decodeQRImage(qrPath);
      expect(decoded).toBe(uri);
    } finally {
      unlinkSync(qrPath);
    }
  });

  it("throws on a file that contains no QR code", () => {
    mkdirSync(testDir, { recursive: true });
    // Write a blank white PNG
    const png = new PNG({ width: 50, height: 50 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = 255;
    writeFileSync(qrPath, PNG.sync.write(png));
    try {
      expect(() => decodeQRImage(qrPath)).toThrow("Could not decode QR code");
    } finally {
      unlinkSync(qrPath);
    }
  });
});
