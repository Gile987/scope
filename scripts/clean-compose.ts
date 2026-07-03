#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// clean-compose.ts — Down compose projects for worktrees with merged/closed PRs
// =============================================================================
// Lists all Docker Compose projects, matches them to git worktrees, queries
// GitHub for PR status, and offers to `docker compose down` projects whose
// worktree's PR is merged/closed (or whose worktree no longer exists).
//
// Usage:
//   npx tsx scripts/clean-compose.ts [--yes] [--dry-run] [--no-volumes]
//   pnpm worktrees:clean:docker
// =============================================================================

import { execSync } from "child_process";
import { existsSync } from "node:fs";
import { createInterface } from "readline";
import { fileURLToPath } from "node:url";
import {
  deletePortOffset,
  parseRemoteUrl,
  parseWorktreeList,
  readPortOffset,
  type PrInfo,
  type Worktree,
} from "./clean-worktrees.js";

export interface ComposeProject {
  name: string;
  status: string;
  configFiles: string[];
}

export type ComposeDecision =
  | { kind: "remove"; reason: string; pr?: PrInfo; worktreePath?: string }
  | { kind: "keep"; reason: string };

export interface ClassifiedProject {
  project: ComposeProject;
  decision: ComposeDecision;
}

/** Raised when the Docker daemon can't be reached (Docker/Colima not running). */
export class DockerUnavailableError extends Error {
  constructor(message = "Docker daemon is not reachable") {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

/**
 * Whether a captured error message/stderr indicates the Docker daemon is not
 * reachable (Docker Desktop / Colima not started), as opposed to a genuine
 * `docker compose` failure. Matching on the daemon-connectivity wording keeps
 * the cleanup script from dumping a raw stack trace for a routine condition.
 */
export function isDockerDaemonUnavailable(message: string): boolean {
  return /cannot connect to the docker daemon|is the docker daemon running|error during connect|the docker daemon is not running/i.test(
    message,
  );
}

export function parseComposeLs(json: string): ComposeProject[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const arr = JSON.parse(trimmed) as Array<{
    Name: string;
    Status: string;
    ConfigFiles: string;
  }>;
  return arr.map((p) => ({
    name: p.Name,
    status: p.Status,
    configFiles: p.ConfigFiles.split(",").map((s) => s.trim()).filter(Boolean),
  }));
}

/**
 * Find the worktree whose path is a prefix of any of the project's config files.
 * Returns the longest-matching worktree (handles nested paths correctly).
 */
export function matchWorktree(
  project: ComposeProject,
  worktrees: Worktree[],
): Worktree | null {
  let best: Worktree | null = null;
  for (const wt of worktrees) {
    const prefix = wt.path.endsWith("/") ? wt.path : wt.path + "/";
    for (const cf of project.configFiles) {
      if (cf === wt.path || cf.startsWith(prefix)) {
        if (!best || wt.path.length > best.path.length) {
          best = wt;
        }
        break;
      }
    }
  }
  return best;
}

export function classifyComposeProjects(
  projects: ComposeProject[],
  worktrees: Worktree[],
  getPr: (branch: string) => PrInfo | null,
  pathExists: (p: string) => boolean = existsSync,
): ClassifiedProject[] {
  return projects.map((project) => {
    const wt = matchWorktree(project, worktrees);

    if (!wt) {
      // Not associated with any known worktree — could be the main repo or
      // an external project. Check if its config files still exist on disk;
      // if none do, it's orphaned.
      const anyExists = project.configFiles.some(pathExists);
      if (!anyExists && project.configFiles.length > 0) {
        return {
          project,
          decision: { kind: "remove", reason: "orphan: config files missing" },
        };
      }
      return {
        project,
        decision: { kind: "keep", reason: "not in a worktree" },
      };
    }

    const pr = getPr(wt.branch);
    if (!pr) {
      return {
        project,
        decision: { kind: "keep", reason: `worktree ${wt.branch}: no PR` },
      };
    }
    if (pr.state === "MERGED" || pr.state === "CLOSED") {
      return {
        project,
        decision: {
          kind: "remove",
          reason: `worktree ${wt.branch}: PR #${pr.number} ${pr.state}`,
          pr,
          // Track the worktree so main() can also free its port offset.
          worktreePath: wt.path,
        },
      };
    }
    return {
      project,
      decision: {
        kind: "keep",
        reason: `worktree ${wt.branch}: PR #${pr.number} ${pr.state}`,
      },
    };
  });
}

function getRemoteRepo(): string {
  const url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
  return parseRemoteUrl(url);
}

function listWorktrees(): Worktree[] {
  const output = execSync("git worktree list --porcelain", { encoding: "utf-8" });
  return parseWorktreeList(output);
}

function listComposeProjects(): ComposeProject[] {
  try {
    const out = execSync("docker compose ls --all --format json", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseComposeLs(out);
  } catch (err: any) {
    const detail = `${err?.stderr?.toString() ?? ""}\n${err?.message ?? ""}`;
    if (isDockerDaemonUnavailable(detail)) {
      throw new DockerUnavailableError();
    }
    throw err;
  }
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

interface CliOptions {
  yes: boolean;
  dryRun: boolean;
  removeVolumes: boolean;
  removeOrphans: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    yes: false,
    dryRun: false,
    removeVolumes: true,
    removeOrphans: true,
  };
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
      case "--no-volumes":
        opts.removeVolumes = false;
        break;
      case "--no-orphans":
        opts.removeOrphans = false;
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
  console.log(`Usage: clean-compose [options]

Down Docker Compose projects whose git worktree has a merged/closed PR
(or whose config files no longer exist on disk).

Options:
  -y, --yes          Skip confirmation prompt
  -n, --dry-run      Show what would be done, don't execute
      --no-volumes   Don't pass -v (keep named volumes)
      --no-orphans   Don't pass --remove-orphans
  -h, --help         Show this help`);
  process.exit(code);
}

function buildDownCommand(name: string, opts: CliOptions): string {
  const flags: string[] = [];
  if (opts.removeVolumes) flags.push("-v");
  if (opts.removeOrphans) flags.push("--remove-orphans");
  return `docker compose -p ${JSON.stringify(name)} down ${flags.join(" ")}`.trim();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const repo = getRemoteRepo();
  const allWorktrees = listWorktrees();
  // The first entry in `git worktree list --porcelain` is the primary checkout.
  // Exclude it so a stray merged PR with the same head name (e.g. `main`)
  // can't trick us into downing the main repo's compose project.
  const primary = allWorktrees[0];
  const worktrees = primary
    ? allWorktrees.filter((wt) => wt.path !== primary.path)
    : allWorktrees;
  const projects = listComposeProjects();

  if (projects.length === 0) {
    console.log("No Docker Compose projects found.");
    return;
  }

  console.log(
    `Found ${projects.length} compose project(s) and ${worktrees.length} worktree(s). Checking PRs against ${repo}...\n`,
  );

  const prCache = new Map<string, PrInfo | null>();
  const getPr = (branch: string): PrInfo | null => {
    if (prCache.has(branch)) return prCache.get(branch) ?? null;
    const pr = getPrStatus(repo, branch);
    prCache.set(branch, pr);
    return pr;
  };

  const classified = classifyComposeProjects(projects, worktrees, getPr);
  const toRemove = classified.filter((c) => c.decision.kind === "remove");
  const kept = classified.filter((c) => c.decision.kind === "keep");

  if (toRemove.length === 0) {
    console.log("Nothing to clean up — no compose projects match a merged/closed PR.");
    if (kept.length > 0) {
      console.log("\nKept:");
      for (const c of kept) {
        console.log(`  [KEEP] ${c.project.name} — ${c.decision.reason}`);
      }
    }
    return;
  }

  console.log("Compose projects to down:\n");
  for (const c of toRemove) {
    console.log(`  [DOWN] ${c.project.name}`);
    console.log(`         status: ${c.project.status}`);
    console.log(`         reason: ${c.decision.reason}\n`);
  }

  if (kept.length > 0) {
    console.log("Compose projects kept:\n");
    for (const c of kept) {
      console.log(`  [KEEP] ${c.project.name} — ${c.decision.reason}`);
    }
    console.log();
  }

  if (opts.dryRun) {
    console.log("(dry run — no changes made)");
    for (const c of toRemove) {
      console.log(`  $ ${buildDownCommand(c.project.name, opts)}`);
      if (c.decision.kind === "remove" && c.decision.worktreePath) {
        const offset = readPortOffset(c.decision.worktreePath);
        if (offset !== null) {
          console.log(`      ↳ would free port offset ${offset}`);
        }
      }
    }
    return;
  }

  if (!opts.yes) {
    const flagSummary = [
      opts.removeVolumes ? "-v" : "",
      opts.removeOrphans ? "--remove-orphans" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const answer = await ask(
      `Down ${toRemove.length} compose project(s) with \`${flagSummary || "(no extra flags)"}\`? [y/N] `,
    );
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  let downed = 0;
  let failed = 0;

  for (const c of toRemove) {
    const cmd = buildDownCommand(c.project.name, opts);
    try {
      execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      console.log(`  ✓ ${c.project.name}`);
      downed++;
      // Also free the worktree's port offset (delete .port-offset) so the
      // number can be reused. Only for worktree-matched removals — orphan
      // projects have no worktree (and thus no offset file) to free.
      if (c.decision.kind === "remove" && c.decision.worktreePath) {
        const wtPath = c.decision.worktreePath;
        const offset = readPortOffset(wtPath);
        if (deletePortOffset(wtPath) && offset !== null) {
          console.log(`    ↳ freed port offset ${offset}`);
        }
      }
    } catch (err: any) {
      console.error(
        `  ✗ ${c.project.name}: ${err.stderr?.toString().trim() || err.message}`,
      );
      failed++;
    }
  }

  console.log(`\nDone: ${downed} downed, ${failed} failed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof DockerUnavailableError) {
      console.log(
        "Docker daemon is not reachable — is Docker/Colima running? Nothing to clean up.",
      );
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
}
