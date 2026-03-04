#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// open-portal.ts — Open the portal in the default browser
// =============================================================================
// Reads .env to determine the portal port (which may vary in a worktree)
// and opens http://localhost:<port> in the default browser.
//
// Usage:
//   npx tsx scripts/open-portal.ts
//   pnpm open:portal
// =============================================================================

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

/**
 * Extract a named port from a .env file content.
 * Returns the value or undefined if not found.
 */
export function extractPort(
  envContent: string,
  portName: string
): number | undefined {
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key === portName) {
      const num = parseInt(value, 10);
      return isNaN(num) ? undefined : num;
    }
  }
  return undefined;
}

const DEFAULT_PORTAL_PORT = 5100;

function main() {
  const repoRoot = join(import.meta.dirname, "..");
  const envFile = join(repoRoot, ".env");

  let port = DEFAULT_PORTAL_PORT;

  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    const parsed = extractPort(content, "PORTAL_PORT");
    if (parsed !== undefined) {
      port = parsed;
    }
  }

  const url = `http://localhost:${port}`;
  console.log(`Opening portal at ${url}`);

  // macOS: open, Linux: xdg-open, Windows: start
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      console.log(`Open this URL in your browser: ${url}`);
    }
  } catch {
    console.log(`Could not open browser automatically. Open this URL manually: ${url}`);
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("open-portal.ts") ||
    process.argv[1].endsWith("open-portal.js"));

if (isDirectExecution) {
  main();
}
