// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// totp.ts — TOTP helpers for automated GitHub MFA authentication
// =============================================================================

import * as OTPAuth from "otpauth";

export interface TOTPParams {
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  issuer?: string;
  label?: string;
}

/**
 * Parse an otpauth:// URI or bare secret into full TOTP parameters.
 *
 * Accepts either:
 *   - A full URI:   otpauth://totp/GitHub:user?secret=XXXX&issuer=GitHub&algorithm=SHA1
 *   - A bare secret: JBSWY3DPEHPK3PXP  (defaults: SHA1, 6 digits, 30s)
 */
export function parseTOTPSecret(input: string): TOTPParams {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const totp = OTPAuth.URI.parse(trimmed);
    return {
      secret: totp.secret.base32,
      algorithm: totp.algorithm,
      digits: totp.digits,
      period: totp.period,
      issuer: totp.issuer || undefined,
      label: totp.label || undefined,
    };
  }

  // Bare base32 secret — use standard defaults
  return { secret: trimmed, algorithm: "SHA1", digits: 6, period: 30 };
}

/**
 * Generate a TOTP code using the given parameters.
 * If timestamp is provided, generates at that specific Unix epoch (seconds).
 */
export function generateTOTP(params: TOTPParams, timestamp?: number): string {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(params.secret),
    digits: params.digits,
    period: params.period,
    algorithm: params.algorithm,
  });
  return totp.generate({ timestamp: timestamp != null ? timestamp * 1000 : undefined });
}
