#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// clean-port-offsets.ts — Reclaim port offsets from "done" worktrees
// =============================================================================
// Each git worktree reserves a scarce port offset (1-99) via a `.port-offset`
// file at its root (managed by `worktree-env`). This script frees that offset —
// by deleting only the `.port-offset` file — for every worktree that is *done*,
// WITHOUT removing the worktree or touching its `.env`.
//
// It decides using BOTH the PR state and the local git state, which cover each
// other's blind spots:
//
//   • PR state (queried once via `gh`, matched by branch name):
//       - OPEN   → keep. Safety veto: an open PR is active, so its offset may
//                  still be in use even if the local checkout looks clean.
//       - MERGED
//         /CLOSED → free (even if the branch still holds commits): the work is
//                  landed or abandoned, so the offset is safe to reclaim.
//   • Git state (fallback when no PR matches the branch):
//       - a branch with NO commits ahead of origin/main (merged-then-reset, or
//         an empty worktree created from main) with a clean working tree → free.
//
// Uncommitted changes always protect a worktree (never freed), regardless of PR
// state. The primary checkout and the worktree you run from are always skipped.
//
// Why both? In this repo's workflow a merged worktree usually does NOT keep a
// branch name matching its merged PR (the branch is reset after merge), so PR
// matching alone reclaims almost nothing — the git-state fallback catches that
// backlog. Conversely, git state alone can't tell a reset-but-still-open PR from
// a truly-done worktree, and would wrongly free an active offset — the PR veto
// catches that. If `gh` can't run (offline, unauthenticated), it degrades to the
// git-state criterion automatically.
//
// To remove whole worktrees instead of just freeing offsets, use
// clean-worktrees.ts.
//
// Usage:
//   npx tsx scripts/clean-port-offsets.ts [--yes] [--dry-run] [--no-fetch]
//   pnpm worktrees:clean:port-offsets
// =============================================================================

import { execSync } from "child_process";
import { createInterface } from "readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deletePortOffset,
  getRemoteRepo,
  parseWorktreeList,
  readPortOffset,
  type Worktree,
} from "./clean-worktrees.js";

/** PR state for a worktree's branch, normalized to lowercase. */
export type PrState = "open" | "closed" | "merged";

/** A PR matched to a worktree branch. */
export interface PrRef {
  number: number;
  state: PrState;
}

/** Everything `selectReclaimable` needs to decide a single worktree's fate. */
export interface WorktreeState extends Worktree {
  /** Persisted port offset, or `null` when there is no `.port-offset` file. */
  offset: string | null;
  /** Commits on this branch that are not in the base ref (`origin/main`). */
  commitsAhead: number;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
  /** The main repo checkout (offset 0 — never touched). */
  isPrimary: boolean;
  /** The worktree this script is running from (never touched). */
  isCurrent: boolean;
  /**
   * PR matched to this branch, or `null` when no PR matches (or PR lookup was
   * skipped/failed — in which case the decision falls back to git state only).
   */
  pr: PrRef | null;
}

export interface ReclaimPlan {
  toFree: (WorktreeState & { offset: string; reason: string })[];
  kept: { state: WorktreeState; reason: string }[];
}

/**
 * Decide, per worktree, whether its port offset can be reclaimed. Pure — every
 * input is already resolved (git/gh/fs probes happen in `main`), so this is
 * fully unit-testable. Precedence (first match wins):
 *
 *   1. primary / current / no offset  → keep (never touched)
 *   2. PR is OPEN                      → keep (safety veto — offset may be live)
 *   3. dirty working tree             → keep (protect uncommitted work)
 *   4. PR is MERGED or CLOSED         → free (landed/abandoned; commits irrelevant)
 *   5. no commits ahead of base ref   → free (merged-then-reset, or empty worktree)
 *   6. otherwise                      → keep (local commits with no PR — WIP)
 */
export function selectReclaimable(states: WorktreeState[]): ReclaimPlan {
  const toFree: (WorktreeState & { offset: string; reason: string })[] = [];
  const kept: { state: WorktreeState; reason: string }[] = [];

  for (const s of states) {
    if (s.isPrimary) {
      kept.push({ state: s, reason: "primary checkout" });
    } else if (s.isCurrent) {
      kept.push({ state: s, reason: "current worktree" });
    } else if (s.offset === null) {
      kept.push({ state: s, reason: "no .port-offset" });
    } else if (s.pr?.state === "open") {
      kept.push({ state: s, reason: `open PR #${s.pr.number}` });
    } else if (s.dirty) {
      kept.push({ state: s, reason: "uncommitted changes" });
    } else if (s.pr && (s.pr.state === "merged" || s.pr.state === "closed")) {
      toFree.push({ ...s, offset: s.offset, reason: `${s.pr.state} PR #${s.pr.number}` });
    } else if (s.commitsAhead === 0) {
      toFree.push({ ...s, offset: s.offset, reason: "no commits ahead of base" });
    } else {
      const n = Number.isFinite(s.commitsAhead) ? s.commitsAhead : "?";
      kept.push({ state: s, reason: `${n} unmerged commit(s)` });
    }
  }

  return { toFree, kept };
}

/**
 * Build a branch → PR map from `gh pr list --json number,headRefName,state`
 * output. Pure and unit-testable. When several PRs share a branch name, an OPEN
 * PR wins (safest); otherwise the first (most recent) is kept.
 */
export function parsePrList(json: string): Map<string, PrRef> {
  const map = new Map<string, PrRef>();
  let arr: { number: number; headRefName: string; state: string }[];
  try {
    arr = JSON.parse(json);
  } catch {
    return map;
  }
  if (!Array.isArray(arr)) return map;
  for (const pr of arr) {
    if (!pr?.headRefName || typeof pr.number !== "number") continue;
    const state = String(pr.state).toLowerCase();
    if (state !== "open" && state !== "closed" && state !== "merged") continue;
    const existing = map.get(pr.headRefName);
    // Prefer an OPEN PR (safety veto); otherwise keep the first one seen.
    if (!existing || state === "open") {
      map.set(pr.headRefName, { number: pr.number, state });
    }
  }
  return map;
}

interface CliOptions {
  yes: boolean;
  dryRun: boolean;
  fetch: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { yes: false, dryRun: false, fetch: true };
  for (const arg of argv) {
    switch (arg) {
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--dry-run":
      case "-n":
        opts.dryRun = true;
        break;
      case "--no-fetch":
        opts.fetch = false;
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          printHelpAndExit(1);
        }
    }
  }
  return opts;
}

function printHelpAndExit(code = 0): never {
  console.log(`Usage: clean-port-offsets [options]

Free the port offset (delete .port-offset) of every git worktree that is done.
A worktree is done when its PR is merged/closed, OR (when no PR matches its
branch) its branch has no commits ahead of origin/main and its tree is clean.
Worktrees with an OPEN PR or uncommitted changes are always kept. The primary
checkout and the worktree you run this from are always skipped. Only the
.port-offset file is deleted — the worktree checkout and its .env are left intact.

Options:
  -y, --yes       Skip confirmation prompt
  -n, --dry-run   Show what would be freed, don't delete
      --no-fetch  Don't 'git fetch origin main' first (use local refs)
  -h, --help      Show this help`);
  process.exit(code);
}

/** Resolve the base branch ref to compare against (origin/HEAD → origin/main). */
function getBaseRef(): string {
  try {
    const ref = execSync("git rev-parse --abbrev-ref origin/HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (ref && ref !== "origin/HEAD") return ref;
  } catch {
    // origin/HEAD not set — fall through.
  }
  return "origin/main";
}

function currentToplevel(): string {
  return resolve(
    execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim(),
  );
}

function listWorktrees(): Worktree[] {
  const output = execSync("git worktree list --porcelain", { encoding: "utf-8" });
  return parseWorktreeList(output);
}

/** Commits on the worktree's HEAD not reachable from the base ref. */
function commitsAhead(worktreePath: string, baseRef: string): number {
  try {
    const out = execSync(
      `git -C ${JSON.stringify(worktreePath)} rev-list --count ${baseRef}..HEAD`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  } catch {
    // Can't determine (missing base ref, bad HEAD, …) — protect the worktree.
    return Number.POSITIVE_INFINITY;
  }
}

function isDirty(worktreePath: string): boolean {
  try {
    const out = execSync(
      `git -C ${JSON.stringify(worktreePath)} status --porcelain`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return out.trim().length > 0;
  } catch {
    // Can't determine — protect the worktree.
    return true;
  }
}

/**
 * Fetch every PR for the repo once and index it by head branch name. Returns
 * `null` when the lookup can't run (no `gh`, not authenticated, no remote, …),
 * in which case the caller falls back to git state only.
 */
function fetchPrStates(): Map<string, PrRef> | null {
  let repo: string;
  try {
    repo = getRemoteRepo();
  } catch {
    return null;
  }
  try {
    const json = execSync(
      `gh pr list --repo ${repo} --state all --json number,headRefName,state --limit 1000`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
    return parsePrList(json);
  } catch {
    return null;
  }
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const baseRef = getBaseRef();
  const baseBranch = baseRef.replace(/^origin\//, "");

  if (opts.fetch) {
    try {
      console.log(`Fetching ${baseRef}...`);
      execSync(`git fetch origin ${baseBranch} --quiet`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      console.log("(fetch failed — proceeding with local refs)");
    }
  }

  const current = currentToplevel();
  const allWorktrees = listWorktrees();
  const primaryPath = allWorktrees.length ? resolve(allWorktrees[0].path) : "";

  // Query PR state once (branch → PR). `null` means the lookup couldn't run
  // (no `gh`, not authenticated, no remote, …) — we then decide by git state
  // only, which is the best we can do without GitHub.
  const prStates = fetchPrStates();
  if (prStates === null) {
    console.log("(PR lookup unavailable — falling back to git state only)");
  }

  console.log(
    `Scanning ${allWorktrees.length} worktree(s) for reclaimable port offsets (base: ${baseRef})...\n`,
  );

  const states: WorktreeState[] = allWorktrees.map((wt) => {
    const p = resolve(wt.path);
    const isPrimary = p === primaryPath;
    const isCurrent = p === current;
    const offset = readPortOffset(wt.path);
    const pr = prStates?.get(wt.branch) ?? null;
    // Skip git probes we don't need. Untouched worktrees (primary/current/no
    // offset) and open-PR worktrees are kept regardless, so probe nothing.
    if (isPrimary || isCurrent || offset === null || pr?.state === "open") {
      return { ...wt, offset, commitsAhead: 0, dirty: false, isPrimary, isCurrent, pr };
    }
    // Merged/closed PR: only dirtiness can still protect it — commits are moot.
    if (pr && (pr.state === "merged" || pr.state === "closed")) {
      return { ...wt, offset, commitsAhead: 0, dirty: isDirty(wt.path), isPrimary, isCurrent, pr };
    }
    // No PR match: fall back to git state. Dirtiness only matters when there are
    // no commits ahead (a branch with unmerged commits is kept either way).
    const ahead = commitsAhead(wt.path, baseRef);
    const dirty = ahead === 0 ? isDirty(wt.path) : false;
    return { ...wt, offset, commitsAhead: ahead, dirty, isPrimary, isCurrent, pr };
  });

  const { toFree, kept } = selectReclaimable(states);

  if (toFree.length === 0) {
    console.log("No reclaimable port offsets — every worktree is active or empty.");
    printKeptSummary(kept);
    return;
  }

  console.log("Port offsets to free:\n");
  for (const wt of toFree) {
    console.log(`  [FREE] offset ${wt.offset.padStart(2)}  ${wt.branch}  (${wt.reason})`);
    console.log(`         ${wt.path}\n`);
  }
  printKeptSummary(kept);

  if (opts.dryRun) {
    console.log("\n(dry run — no changes made)");
    return;
  }

  if (!opts.yes) {
    const answer = await ask(`\nFree ${toFree.length} port offset(s)? [y/N] `);
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  let freed = 0;
  let failed = 0;

  for (const wt of toFree) {
    try {
      if (deletePortOffset(wt.path)) {
        console.log(`  ✓ offset ${wt.offset} — ${wt.branch}`);
        freed++;
      } else {
        // Raced with another cleanup — the file vanished between scan and delete.
        console.log(`  · offset ${wt.offset} — ${wt.branch} (already gone)`);
      }
    } catch (err: any) {
      console.error(`  ✗ ${wt.branch}: ${err?.message ?? err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${freed} freed, ${failed} failed.`);
}

/** Print a compact "kept N (reason breakdown)" line so the outcome is legible. */
function printKeptSummary(kept: { state: WorktreeState; reason: string }[]): void {
  if (kept.length === 0) return;
  const counts = new Map<string, number>();
  for (const k of kept) {
    // Collapse variable commit counts and PR numbers into stable buckets.
    let key: string;
    if (/unmerged commit/.test(k.reason)) key = "unmerged commits";
    else if (/^open PR #/.test(k.reason)) key = "open PR";
    else key = k.reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  console.log(`Kept ${kept.length} worktree(s): ${breakdown}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
