#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// clean-worktrees.ts — Remove worktrees whose PRs are merged or closed
// =============================================================================
// Lists all git worktrees, queries GitHub for the PR status of each branch,
// and offers to remove worktrees whose PRs are merged or closed.
//
// Usage:
//   npx tsx scripts/clean-worktrees.ts
//   pnpm clean:worktrees
// =============================================================================

import { execSync } from "child_process";
import { createInterface } from "readline";

export interface Worktree {
  path: string;
  branch: string;
}

export interface PrInfo {
  number: number;
  state: string;
  title: string;
}

export function parseRemoteUrl(url: string): string {
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`);
  }
  return match[1];
}

function getRemoteRepo(): string {
  const url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
  return parseRemoteUrl(url);
}

export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let currentPath = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      const branch = line.slice("branch refs/heads/".length);
      worktrees.push({ path: currentPath, branch });
    }
  }

  return worktrees;
}

function listWorktrees(): Worktree[] {
  const output = execSync("git worktree list --porcelain", { encoding: "utf-8" });
  return parseWorktreeList(output);
}

export function classifyWorktrees(
  worktrees: Worktree[],
  getPr: (branch: string) => PrInfo | null,
): { toRemove: (Worktree & { pr: PrInfo })[]; kept: (Worktree & { reason: string })[] } {
  const toRemove: (Worktree & { pr: PrInfo })[] = [];
  const kept: (Worktree & { reason: string })[] = [];

  for (const wt of worktrees) {
    const pr = getPr(wt.branch);
    if (!pr) {
      kept.push({ ...wt, reason: "no PR" });
    } else if (pr.state === "MERGED" || pr.state === "CLOSED") {
      toRemove.push({ ...wt, pr });
    } else {
      kept.push({ ...wt, reason: `PR #${pr.number} is ${pr.state}` });
    }
  }

  return { toRemove, kept };
}

function getPrStatus(repo: string, branch: string): PrInfo | null {
  try {
    const json = execSync(
      `gh pr list --repo ${repo} --head ${branch} --state all --json number,state,title --jq '.[0]'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!json || json === "null") return null;
    return JSON.parse(json) as PrInfo;
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
  const repo = getRemoteRepo();
  const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
  const worktrees = listWorktrees().filter((wt) => wt.branch !== mainBranch);

  if (worktrees.length === 0) {
    console.log("No worktrees to check.");
    return;
  }

  console.log(`Checking ${worktrees.length} worktree(s) against ${repo}...\n`);

  const { toRemove, kept } = classifyWorktrees(worktrees, (branch) =>
    getPrStatus(repo, branch),
  );

  if (toRemove.length === 0) {
    console.log("No worktrees to clean up — all PRs are open or have no PR.");
    return;
  }

  console.log("Worktrees to remove:\n");
  for (const wt of toRemove) {
    const tag = wt.pr.state === "MERGED" ? "MERGED" : "CLOSED";
    console.log(`  [${tag}] #${wt.pr.number} ${wt.branch}`);
    console.log(`          ${wt.pr.title}`);
    console.log(`          ${wt.path}\n`);
  }

  if (kept.length > 0) {
    console.log("Worktrees kept:\n");
    for (const wt of kept) {
      console.log(`  [KEEP]  ${wt.branch} — ${wt.reason}`);
    }
    console.log();
  }

  const answer = await ask(
    `Remove ${toRemove.length} worktree(s)? [y/N] `,
  );

  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    return;
  }

  let removed = 0;
  let failed = 0;

  for (const wt of toRemove) {
    try {
      execSync(`git worktree remove ${JSON.stringify(wt.path)} --force`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(`  ✓ ${wt.branch}`);
      removed++;
    } catch (err: any) {
      console.error(`  ✗ ${wt.branch}: ${err.stderr?.trim() || err.message}`);
      failed++;
    }
  }

  // Clean up stale entries
  execSync("git worktree prune", { encoding: "utf-8" });

  console.log(`\nDone: ${removed} removed, ${failed} failed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
