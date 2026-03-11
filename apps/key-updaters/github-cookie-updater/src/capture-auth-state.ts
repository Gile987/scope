#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// capture-auth-state.ts — Capture GitHub browser auth state for VS Code Web
// =============================================================================
// Launches a headed Chromium browser pointed at github.com/login.
// Sign in manually, then press Enter in this terminal to save the
// storage state (cookies + localStorage) to a JSON file.
//
// Usage:
//   npx tsx scripts/capture-auth-state.ts [output-path]
//   pnpm capture-auth-state
//
// Default output: .auth/github-storage.json
// =============================================================================

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline";

export const DEFAULT_OUTPUT = ".auth/github-storage.json";

/**
 * Resolve the output path from CLI args or fall back to default.
 */
export function resolveOutputPath(args: string[]): string {
  return args[2] || DEFAULT_OUTPUT;
}

/**
 * Ensure the parent directory of a file path exists.
 */
export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function main() {
  const outputPath = resolveOutputPath(process.argv);

  console.log("🌐 Launching browser — sign in to GitHub, then come back here and press Enter.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://github.com/login");

  // Wait for the user to sign in
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question("✅ Press Enter after you have signed in to GitHub... ", () => {
      rl.close();
      resolve();
    });
  });

  // Save storage state
  ensureDir(outputPath);
  await context.storageState({ path: outputPath });

  await browser.close();

  console.log(`\n💾 Auth state saved to: ${outputPath}`);
  console.log(`\nTo use locally, set the env var:\n  export GITHUB_AUTH_STATE=$(cat ${outputPath})`);
  console.log(`\nTo upload to Key Vault:\n  cd scope-mt-infra && ./scripts/update-keyvault-secrets.sh github-vscode-web-auth-state @${outputPath} --sync`);
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("capture-auth-state.ts") ||
    process.argv[1].endsWith("capture-auth-state.js"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
  });
}
