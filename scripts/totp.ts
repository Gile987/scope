// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// totp.ts — TOTP helpers for automated GitHub MFA authentication
// =============================================================================

import * as OTPAuth from "otpauth";

/**
 * Parse an otpauth:// URI into its components.
 *
 * Accepts either:
 *   - A full URI:   otpauth://totp/GitHub:user?secret=XXXX&issuer=GitHub
 *   - A bare secret: JBSWY3DPEHPK3PXP
 */
export function parseTOTPSecret(input: string): {
  secret: string;
  issuer?: string;
  label?: string;
} {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const totp = OTPAuth.URI.parse(trimmed);
    return {
      secret: totp.secret.base32,
      issuer: totp.issuer || undefined,
      label: totp.label || undefined,
    };
  }

  // Bare base32 secret
  return { secret: trimmed };
}

/**
 * Generate a 6-digit TOTP code from a base32-encoded secret.
 */
export function generateTOTP(secret: string): string {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });
  return totp.generate();
}
