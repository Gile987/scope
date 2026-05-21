#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// github-cookie-updater.ts — Automated GitHub browser auth with TOTP MFA
// =============================================================================
// Automates the GitHub login flow using Playwright:
//   1. Navigates to github.com/login
//   2. Fills in username + password
//   3. Generates a TOTP code from the provided secret and fills the MFA form
//   4. Saves the resulting Playwright storageState (cookies + localStorage)
//
// Usage:
//   npx tsx src/github-cookie-updater.ts \
//     --username USER --password PASS --totp-secret SECRET [--output PATH] [--headed]
//
//   Or with a QR code image (PNG):
//     npx tsx src/github-cookie-updater.ts \
//       --username USER --password PASS --qr-code /path/to/qr.png [--output PATH] [--headed]
//
//   Or via env vars:
//     GH_AUTH_USERNAME=... GH_AUTH_PASSWORD=... GH_AUTH_TOTP_SECRET=... npx tsx src/github-cookie-updater.ts
//
// Default output: .auth/github-storage.json
// =============================================================================

import { writeFileSync } from "fs";
import { createTOTP, getTOTPInfo, loginAndCaptureCookies } from "github-auth";
import { decodeQRImage } from "./totp.js";
import { ensureDir, DEFAULT_OUTPUT } from "./capture-auth-state.js";

export interface AutoAuthOptions {
  username: string;
  password: string;
  totpSecret: string;
  output: string;
  headed: boolean;
  totpOnly: boolean;
}

/**
 * Parse CLI args and env vars into AutoAuthOptions.
 */
export function resolveOptions(
  argv: string[],
  env: Record<string, string | undefined>
): AutoAuthOptions {
  const args = argv.slice(2);
  const flagIndex = (name: string) => args.indexOf(name);
  const flagValue = (name: string): string | undefined => {
    const i = flagIndex(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const username = flagValue("--username") ?? env.GH_AUTH_USERNAME;
  const password = flagValue("--password") ?? env.GH_AUTH_PASSWORD;
  const qrCode = flagValue("--qr-code");
  const output = flagValue("--output") ?? DEFAULT_OUTPUT;
  const headed = args.includes("--headed");
  const totpOnly = args.includes("--totp-only");

  // Resolve TOTP secret: --qr-code decodes a PNG image, --totp-secret uses the value directly
  let totpSecret: string | undefined;
  if (qrCode) {
    const decoded = decodeQRImage(qrCode);
    console.log(`📷 Decoded QR code: ${decoded}`);
    totpSecret = decoded;
  } else {
    totpSecret = flagValue("--totp-secret") ?? env.GH_AUTH_TOTP_SECRET;
  }

  if (!totpSecret)
    throw new Error("Missing --totp-secret, --qr-code, or GH_AUTH_TOTP_SECRET env var");

  if (!totpOnly) {
    if (!username) throw new Error("Missing --username or GH_AUTH_USERNAME env var");
    if (!password) throw new Error("Missing --password or GH_AUTH_PASSWORD env var");
  }

  return { username: username ?? "", password: password ?? "", totpSecret, output, headed, totpOnly };
}

const LOGIN_TIMEOUT_MS = 30_000;

async function main() {
  const opts = resolveOptions(process.argv, process.env as Record<string, string | undefined>);

  // Create TOTP instance (supports both bare secret and otpauth:// URI)
  const totp = createTOTP(opts.totpSecret);
  const info = getTOTPInfo(totp);

  // --totp-only mode: print codes with diagnostics and exit
  if (opts.totpOnly) {
    const now = Math.floor(Date.now() / 1000);
    const step = Math.floor(now / info.period);
    const remaining = info.period - (now % info.period);

    const prevCode = totp.generate({ timestamp: (step - 1) * info.period * 1000 });
    const currCode = totp.generate({ timestamp: step * info.period * 1000 });
    const nextCode = totp.generate({ timestamp: (step + 1) * info.period * 1000 });

    console.log(`Previous:  ${prevCode}`);
    console.log(`Current:   ${currCode}  ← use this one`);
    console.log(`Next:      ${nextCode}`);
    console.log();
    console.log(`Algorithm: ${info.algorithm}`);
    console.log(`Digits:    ${info.digits}`);
    console.log(`Period:    ${info.period}s`);
    console.log(`Remaining: ${remaining}s`);
    console.log(`System:    ${new Date().toISOString()}`);
    console.log(`Epoch:     ${now}`);
    return;
  }

  console.log("🔐 Starting automated GitHub login...");

  const { storageState } = await loginAndCaptureCookies({
    username: opts.username,
    password: opts.password,
    totpSecret: opts.totpSecret,
    headed: opts.headed,
  });

  // Save storage state to file
  ensureDir(opts.output);
  writeFileSync(opts.output, storageState);

  console.log(`\n💾 Auth state saved to: ${opts.output}`);
  console.log(
    `\nTo use locally, set the env var:\n  export GITHUB_AUTH_STATE=$(cat ${opts.output})`
  );
  console.log(
    `\nTo upload to Key Vault:\n  cd scope-mt-infra && ./scripts/update-keyvault-secrets.sh github-vscode-web-auth-state @${opts.output} --sync`
  );
}

// Only run main when executed directly
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("github-cookie-updater.ts") ||
    process.argv[1].endsWith("github-cookie-updater.js"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  });
}
