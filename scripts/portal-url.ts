#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// portal-url.ts — Display the portal URL
// =============================================================================
// Reads .env to determine the portal port (which may vary in a worktree)
// and prints http://localhost:<port> to stdout.
//
// Usage:
//   npx tsx scripts/portal-url.ts
//   pnpm portal:url
// =============================================================================

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractPort } from "./open-portal.js";

const DEFAULT_PORTAL_PORT = 5100;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const envFile = join(repoRoot, ".env");

let port = DEFAULT_PORTAL_PORT;

if (existsSync(envFile)) {
  const content = readFileSync(envFile, "utf-8");
  const parsed = extractPort(content, "PORTAL_PORT");
  if (parsed !== undefined) {
    port = parsed;
  }
}

console.log(`http://localhost:${port}`);
