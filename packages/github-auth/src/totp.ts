// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// totp.ts — TOTP helpers for automated GitHub MFA authentication
// =============================================================================

import * as OTPAuth from "otpauth";

export interface TOTPInfo {
  algorithm: string;
  digits: number;
  period: number;
  issuer?: string;
  label?: string;
}

/**
 * Create a TOTP instance from an otpauth:// URI or bare base32 secret.
 *
 * Accepts either:
 *   - A full URI:   otpauth://totp/GitHub:user?secret=XXXX&issuer=GitHub&algorithm=SHA1
 *   - A bare secret: JBSWY3DPEHPK3PXP  (defaults: SHA1, 6 digits, 30s)
 *
 * Returns the ready-to-use OTPAuth.TOTP instance (no round-tripping through base32).
 */
export function createTOTP(input: string): OTPAuth.TOTP {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const parsed = OTPAuth.URI.parse(trimmed);
    if (!(parsed instanceof OTPAuth.TOTP)) {
      throw new Error("URI must be a TOTP URI (otpauth://totp/...)");
    }
    return parsed;
  }

  // Bare base32 secret — use standard defaults
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(trimmed),
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });
}

/**
 * Extract display info from a TOTP instance.
 */
export function getTOTPInfo(totp: OTPAuth.TOTP): TOTPInfo {
  return {
    algorithm: totp.algorithm,
    digits: totp.digits,
    period: totp.period,
    issuer: totp.issuer || undefined,
    label: totp.label || undefined,
  };
}
