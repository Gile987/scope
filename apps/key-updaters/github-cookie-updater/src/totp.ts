// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// totp.ts — Re-exports from github-auth + QR code decoding (CLI-only)
// =============================================================================

import * as fs from "node:fs";
import { PNG } from "pngjs";
import decodeQR from "qr/decode.js";

// Re-export shared TOTP helpers from github-auth
export { createTOTP, getTOTPInfo } from "github-auth";
export type { TOTPInfo } from "github-auth";

/**
 * Read a QR code image (PNG) and decode its content to an otpauth:// URI string.
 *
 * The file must be a PNG image containing a valid QR code.
 * Returns the decoded text (typically an otpauth:// URI).
 */
export function decodeQRImage(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);

  let decoded: string | undefined;
  try {
    decoded = decodeQR({ width: png.width, height: png.height, data: png.data });
  } catch {
    throw new Error(`Could not decode QR code from: ${filePath}`);
  }
  if (!decoded) {
    throw new Error(`Could not decode QR code from: ${filePath}`);
  }
  return decoded;
}
