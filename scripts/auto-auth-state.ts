#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// auto-auth-state.ts — Automated GitHub browser auth with TOTP MFA
// =============================================================================
// Automates the GitHub login flow using Playwright:
//   1. Navigates to github.com/login
//   2. Fills in username + password
//   3. Generates a TOTP code from the provided secret and fills the MFA form
//   4. Saves the resulting Playwright storageState (cookies + localStorage)
//
// Usage:
//   npx tsx scripts/auto-auth-state.ts \
//     --username USER --password PASS --totp-secret SECRET [--output PATH] [--headed]
//
//   Or via env vars:
//     GITHUB_USERNAME=... GITHUB_PASSWORD=... GITHUB_TOTP_SECRET=... npx tsx scripts/auto-auth-state.ts
//
// Default output: .auth/github-storage.json
// =============================================================================

import { chromium } from "playwright";
import { parseTOTPSecret, generateTOTP } from "./totp.js";
import { ensureDir, DEFAULT_OUTPUT } from "./capture-auth-state.js";

export interface AutoAuthOptions {
  username: string;
  password: string;
  totpSecret: string;
  output: string;
  headed: boolean;
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

  const username = flagValue("--username") ?? env.GITHUB_USERNAME;
  const password = flagValue("--password") ?? env.GITHUB_PASSWORD;
  const totpSecret = flagValue("--totp-secret") ?? env.GITHUB_TOTP_SECRET;
  const output = flagValue("--output") ?? DEFAULT_OUTPUT;
  const headed = args.includes("--headed");

  if (!username) throw new Error("Missing --username or GITHUB_USERNAME env var");
  if (!password) throw new Error("Missing --password or GITHUB_PASSWORD env var");
  if (!totpSecret)
    throw new Error("Missing --totp-secret or GITHUB_TOTP_SECRET env var");

  return { username, password, totpSecret, output, headed };
}

const LOGIN_TIMEOUT_MS = 30_000;

async function main() {
  const opts = resolveOptions(process.argv, process.env as Record<string, string | undefined>);

  // Parse TOTP secret (supports both bare secret and otpauth:// URI)
  const { secret } = parseTOTPSecret(opts.totpSecret);

  console.log("🔐 Starting automated GitHub login...");

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 1: Navigate to login page
    await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });

    // Step 2: Fill in credentials and submit
    await page.fill("#login_field", opts.username);
    await page.fill("#password", opts.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS }),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);

    // Step 3: Check for login error
    const errorBanner = page.locator(".js-flash-alert, #js-flash-container .flash-error");
    if (await errorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
      const errorText = await errorBanner.first().textContent();
      throw new Error(`GitHub login failed: ${errorText?.trim()}`);
    }

    // Step 4: Handle MFA if present
    const totpField = page.locator("#app_totp");
    if (await totpField.isVisible({ timeout: 5000 }).catch(() => false)) {
      const code = generateTOTP(secret);
      console.log("🔑 Entering TOTP code...");
      await totpField.fill(code);

      // Submit the TOTP form
      const verifyButton = page.locator('button[type="submit"]');
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS }),
        verifyButton.click(),
      ]);

      // Check for TOTP error (wrong code)
      if (await errorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
        const errorText = await errorBanner.first().textContent();
        throw new Error(`TOTP verification failed: ${errorText?.trim()}`);
      }
    }

    // Step 5: Wait for session cookie to appear (works regardless of final URL)
    console.log("⏳ Waiting for session cookie...");
    await page.waitForFunction(
      () => document.cookie.includes("logged_in=yes"),
      { timeout: LOGIN_TIMEOUT_MS }
    );

    // Step 6: Verify we're authenticated
    const cookies = await context.cookies();
    const hasSession = cookies.some(
      (c) => c.name === "user_session" && c.domain === "github.com"
    );
    if (!hasSession) {
      throw new Error(
        "Login appeared to succeed but no user_session cookie was found"
      );
    }

    // Step 7: Save storage state
    ensureDir(opts.output);
    await context.storageState({ path: opts.output });

    console.log(`\n💾 Auth state saved to: ${opts.output}`);
    console.log(
      `\nTo use locally, set the env var:\n  export GITHUB_AUTH_STATE=$(cat ${opts.output})`
    );
    console.log(
      `\nTo upload to Key Vault:\n  cd scope-mt-infra && ./scripts/update-keyvault-secrets.sh github-vscode-web-auth-state @${opts.output} --sync`
    );
  } finally {
    await browser.close();
  }
}

// Only run main when executed directly
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("auto-auth-state.ts") ||
    process.argv[1].endsWith("auto-auth-state.js"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  });
}
