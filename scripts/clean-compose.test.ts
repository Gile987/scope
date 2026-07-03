// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  parseComposeLs,
  matchWorktree,
  classifyComposeProjects,
  parseArgs,
  isDockerDaemonUnavailable,
  type ComposeProject,
} from "./clean-compose.js";
import type { PrInfo, Worktree } from "./clean-worktrees.js";

describe("parseComposeLs", () => {
  it("parses docker compose ls JSON output", () => {
    const json = JSON.stringify([
      {
        Name: "scope-mt-app",
        Status: "exited(19)",
        ConfigFiles: "/repo/docker-compose.yml,/repo/docker-compose.dev.yml",
      },
    ]);
    expect(parseComposeLs(json)).toEqual([
      {
        name: "scope-mt-app",
        status: "exited(19)",
        configFiles: ["/repo/docker-compose.yml", "/repo/docker-compose.dev.yml"],
      },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseComposeLs("")).toEqual([]);
  });

  it("trims whitespace in config file paths", () => {
    const json = JSON.stringify([
      { Name: "x", Status: "running", ConfigFiles: " /a.yml , /b.yml " },
    ]);
    expect(parseComposeLs(json)[0].configFiles).toEqual(["/a.yml", "/b.yml"]);
  });
});

describe("isDockerDaemonUnavailable", () => {
  it("detects the Colima/Docker daemon-down message", () => {
    expect(
      isDockerDaemonUnavailable(
        "Cannot connect to the Docker daemon at unix:///Users/x/.colima/default/docker.sock. Is the docker daemon running?",
      ),
    ).toBe(true);
  });

  it("detects the Docker Desktop connect error", () => {
    expect(
      isDockerDaemonUnavailable(
        "error during connect: this error may indicate that the docker daemon is not running",
      ),
    ).toBe(true);
  });

  it("returns false for an unrelated compose error", () => {
    expect(
      isDockerDaemonUnavailable("no configuration file provided: not found"),
    ).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isDockerDaemonUnavailable("")).toBe(false);
  });
});

describe("matchWorktree", () => {
  const worktrees: Worktree[] = [
    { path: "/repo", branch: "main" },
    { path: "/repo/.worktrees/feat-a", branch: "feat/a" },
    { path: "/repo/.worktrees/feat-a-extra", branch: "feat/a-extra" },
  ];

  it("matches the longest worktree path prefix", () => {
    const project: ComposeProject = {
      name: "p",
      status: "running",
      configFiles: ["/repo/.worktrees/feat-a/docker-compose.yml"],
    };
    expect(matchWorktree(project, worktrees)?.branch).toBe("feat/a");
  });

  it("does not confuse sibling paths with shared prefix", () => {
    const project: ComposeProject = {
      name: "p",
      status: "running",
      configFiles: ["/repo/.worktrees/feat-a-extra/docker-compose.yml"],
    };
    expect(matchWorktree(project, worktrees)?.branch).toBe("feat/a-extra");
  });

  it("returns null when no worktree matches", () => {
    const project: ComposeProject = {
      name: "p",
      status: "running",
      configFiles: ["/elsewhere/docker-compose.yml"],
    };
    expect(matchWorktree(project, worktrees)).toBeNull();
  });

  it("matches the main repo worktree", () => {
    const project: ComposeProject = {
      name: "p",
      status: "running",
      configFiles: ["/repo/docker-compose.yml"],
    };
    expect(matchWorktree(project, worktrees)?.branch).toBe("main");
  });
});

describe("classifyComposeProjects", () => {
  const worktrees: Worktree[] = [
    { path: "/repo", branch: "main" },
    { path: "/repo/.worktrees/merged", branch: "feat/merged" },
    { path: "/repo/.worktrees/open", branch: "feat/open" },
    { path: "/repo/.worktrees/no-pr", branch: "feat/no-pr" },
  ];

  const prMap: Record<string, PrInfo | null> = {
    main: null,
    "feat/merged": { number: 1, state: "MERGED", title: "Merged" },
    "feat/open": { number: 2, state: "OPEN", title: "Open" },
    "feat/no-pr": null,
  };

  const getPr = (b: string) => prMap[b] ?? null;

  const project = (name: string, configDir: string): ComposeProject => ({
    name,
    status: "running",
    configFiles: [`${configDir}/docker-compose.yml`],
  });

  it("removes projects in worktrees with merged PRs", () => {
    const projects = [project("merged", "/repo/.worktrees/merged")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => true);
    expect(result[0].decision.kind).toBe("remove");
  });

  it("keeps projects in worktrees with open PRs", () => {
    const projects = [project("open", "/repo/.worktrees/open")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => true);
    expect(result[0].decision.kind).toBe("keep");
  });

  it("keeps projects in worktrees with no PR", () => {
    const projects = [project("no-pr", "/repo/.worktrees/no-pr")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => true);
    expect(result[0].decision.kind).toBe("keep");
  });

  it("keeps projects in the main worktree (no PR)", () => {
    const projects = [project("main-app", "/repo")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => true);
    expect(result[0].decision.kind).toBe("keep");
  });

  it("removes orphan projects whose config files no longer exist", () => {
    const projects = [project("orphan", "/elsewhere/gone")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => false);
    expect(result[0].decision.kind).toBe("remove");
    if (result[0].decision.kind === "remove") {
      expect(result[0].decision.reason).toMatch(/orphan/);
    }
  });

  it("records the worktree path on merged/closed removals (for offset freeing)", () => {
    const projects = [project("merged", "/repo/.worktrees/merged")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => true);
    expect(result[0].decision.kind).toBe("remove");
    if (result[0].decision.kind === "remove") {
      expect(result[0].decision.worktreePath).toBe("/repo/.worktrees/merged");
    }
  });

  it("leaves worktreePath undefined on orphan removals", () => {
    const projects = [project("orphan", "/elsewhere/gone")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => false);
    expect(result[0].decision.kind).toBe("remove");
    if (result[0].decision.kind === "remove") {
      expect(result[0].decision.worktreePath).toBeUndefined();
    }
  });

  it("keeps unmatched projects whose config files still exist", () => {
    const projects = [project("external", "/elsewhere/here")];
    const result = classifyComposeProjects(projects, worktrees, getPr, () => true);
    expect(result[0].decision.kind).toBe("keep");
  });
});

describe("parseArgs", () => {
  it("returns sensible defaults", () => {
    expect(parseArgs([])).toEqual({
      yes: false,
      dryRun: false,
      removeVolumes: true,
      removeOrphans: true,
    });
  });

  it("parses --yes and -y", () => {
    expect(parseArgs(["--yes"]).yes).toBe(true);
    expect(parseArgs(["-y"]).yes).toBe(true);
  });

  it("parses --dry-run and -n", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["-n"]).dryRun).toBe(true);
  });

  it("parses --no-volumes and --no-orphans", () => {
    const opts = parseArgs(["--no-volumes", "--no-orphans"]);
    expect(opts.removeVolumes).toBe(false);
    expect(opts.removeOrphans).toBe(false);
  });
});
