#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// worktree-env.ts — Per-worktree Docker Compose port offset
// =============================================================================
// Run this script before docker compose to compute offset ports for worktree
// isolation. Writes computed values into a managed section of .env (auto-loaded
// by Docker Compose).
//
// Usage:
//   npx tsx scripts/worktree-env.ts
//
// In main repo:  offset = 0, base ports used as-is.
// In worktree:   offset = round-robin integer (1-99), persisted in .port-offset.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join, basename, dirname } from "path";

const BEGIN_MARKER = "# --- BEGIN managed by worktree-env.sh (do not edit) ---";
const END_MARKER = "# --- END managed by worktree-env.sh ---";

// --- Types -------------------------------------------------------------------

interface PortEntry {
  name: string;
  base: number;
}

interface WorktreeEnvResult {
  worktreeName: string | null;
  offset: number;
  ports: Record<string, number>;
  composeProjectName: string;
}

// --- Core logic (exported for testing) ---------------------------------------

/**
 * Count trailing zeros of a number.
 * e.g. 27000 → 3, 6300 → 2, 3140 → 1, 3141 → 0
 */
export function countTrailingZeros(n: number): number {
  if (n === 0) return 1;
  const s = String(n);
  let zeros = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === "0") zeros++;
    else break;
  }
  return zeros;
}

/**
 * Validate base ports. Returns { errors, warnings }.
 */
export function validateBasePorts(ports: PortEntry[]): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const { name, base } of ports) {
    const zeros = countTrailingZeros(base);
    if (zeros < 1) {
      errors.push(
        `Base port ${name}=${base} has no trailing zeros — no room for offsets`
      );
    } else if (zeros < 2) {
      warnings.push(
        `Base port ${name}=${base} has only 1 trailing zero — only 10 offsets available`
      );
    }
  }
  return { errors, warnings };
}

/**
 * Parse .env.base file content into port entries.
 * Expects lines like `MONGODB_PORT=27000`.
 */
export function parseEnvBase(content: string): PortEntry[] {
  const ports: PortEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!name || !value) continue;
    const num = parseInt(value, 10);
    if (isNaN(num)) continue;
    ports.push({ name, base: num });
  }
  return ports;
}

/**
 * Find the lowest unused positive integer offset by scanning
 * sibling worktree .port-offset files.
 */
export function findLowestUnusedOffset(
  worktreesDir: string,
  currentWorktree: string
): number {
  const taken = new Set<number>();
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === currentWorktree) continue;
      const offsetFile = join(worktreesDir, entry.name, ".port-offset");
      if (existsSync(offsetFile)) {
        const val = parseInt(readFileSync(offsetFile, "utf-8").trim(), 10);
        if (!isNaN(val)) taken.add(val);
      }
    }
  }
  let offset = 1;
  while (taken.has(offset)) offset++;
  return offset;
}

/**
 * Compute the worktree env: detect worktree, assign offset, compute ports.
 */
export function computeWorktreeEnv(
  repoRoot: string,
  basePorts: PortEntry[]
): WorktreeEnvResult {
  let worktreeName: string | null = null;
  let offset = 0;

  // Detect worktree by checking if repoRoot is inside a .worktrees/ directory
  const parentDir = dirname(repoRoot);
  const grandparentBase = basename(parentDir);

  if (grandparentBase === ".worktrees") {
    worktreeName = basename(repoRoot);
    const portOffsetFile = join(repoRoot, ".port-offset");

    if (existsSync(portOffsetFile)) {
      offset = parseInt(readFileSync(portOffsetFile, "utf-8").trim(), 10);
      if (isNaN(offset)) offset = 1;
    } else {
      offset = findLowestUnusedOffset(parentDir, worktreeName);

      // Validate offset doesn't exceed range for any port
      for (const { name, base } of basePorts) {
        const zeros = countTrailingZeros(base);
        const maxOffset = Math.pow(10, zeros) - 1;
        if (offset > maxOffset) {
          throw new Error(
            `Offset ${offset} exceeds available range for ${name} (base=${base}, max_offset=${maxOffset})`
          );
        }
      }

      writeFileSync(portOffsetFile, String(offset) + "\n");
    }
  }

  // Compute final ports
  const ports: Record<string, number> = {};
  for (const { name, base } of basePorts) {
    ports[name] = base + offset;
  }

  const composeProjectName = worktreeName
    ? `scope-mt-app-${worktreeName}`
    : "scope-mt-app";

  return { worktreeName, offset, ports, composeProjectName };
}

/**
 * Update the .env file with the managed section.
 * Preserves any content outside the BEGIN/END markers.
 */
export function updateEnvFile(
  envFilePath: string,
  result: WorktreeEnvResult
): void {
  // Build managed block
  const sortedKeys = Object.keys(result.ports).sort();
  const managedLines = [
    BEGIN_MARKER,
    `# Worktree: ${result.worktreeName ?? "main"}  |  Offset: ${result.offset}`,
    `# Auto-generated — changes will be overwritten on next run.`,
    `COMPOSE_PROJECT_NAME=${result.composeProjectName}`,
    ...sortedKeys.map((k) => `${k}=${result.ports[k]}`),
    END_MARKER,
  ];
  const managedBlock = managedLines.join("\n");

  if (existsSync(envFilePath)) {
    const existing = readFileSync(envFilePath, "utf-8");
    const beginIdx = existing.indexOf(BEGIN_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (beginIdx !== -1 && endIdx !== -1) {
      // Replace existing managed block
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(endIdx + END_MARKER.length);
      writeFileSync(envFilePath, before + managedBlock + after);
    } else {
      // Append managed block
      const trailing = existing.endsWith("\n") ? "" : "\n";
      writeFileSync(envFilePath, existing + trailing + "\n" + managedBlock + "\n");
    }
  } else {
    writeFileSync(envFilePath, managedBlock + "\n");
  }
}

// --- CLI entry point ---------------------------------------------------------

function main(): void {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const repoRoot = join(scriptDir, "..");
  const envBasePath = join(repoRoot, ".env.base");
  const envFilePath = join(repoRoot, ".env");

  // Read and parse .env.base
  if (!existsSync(envBasePath)) {
    console.error(`ERROR: ${envBasePath} not found`);
    process.exit(1);
  }
  const basePorts = parseEnvBase(readFileSync(envBasePath, "utf-8"));

  // Validate base ports
  const { errors, warnings } = validateBasePorts(basePorts);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    process.exit(1);
  }

  // Detect worktree via git
  let gitToplevel: string;
  try {
    gitToplevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: repoRoot,
    }).trim();
  } catch {
    gitToplevel = repoRoot;
  }

  // Compute env
  const result = computeWorktreeEnv(gitToplevel, basePorts);

  // Write .env
  updateEnvFile(envFilePath, result);

  // Summary
  const label = result.worktreeName ?? "main";
  console.log(
    `[worktree-env] ${label} | Offset: ${result.offset} | API: ${result.ports.API_PORT ?? "?"} | MongoDB: ${result.ports.MONGODB_PORT ?? "?"} | Redis: ${result.ports.REDIS_PORT ?? "?"} | Project: ${result.composeProjectName}`
  );
}

// Only run when executed directly (not imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith("worktree-env.ts") ||
  process.argv[1]?.endsWith("worktree-env.js");
if (isDirectRun) {
  main();
}
