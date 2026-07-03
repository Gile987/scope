// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRemoteUrl,
  parseWorktreeList,
  classifyWorktrees,
  portOffsetPath,
  readPortOffset,
  deletePortOffset,
} from "./clean-worktrees.js";
import type { PrInfo } from "./clean-worktrees.js";

describe("parseRemoteUrl", () => {
  it("parses HTTPS URL", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("parses HTTPS URL without .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("parses SSH URL", () => {
    expect(parseRemoteUrl("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  it("handles org/repo with hyphens", () => {
    expect(parseRemoteUrl("https://github.com/my-org/my-repo.git")).toBe("my-org/my-repo");
  });

  it("throws on non-GitHub URL", () => {
    expect(() => parseRemoteUrl("https://gitlab.com/owner/repo.git")).toThrow(
      "Cannot parse GitHub owner/repo",
    );
  });
});

describe("parseWorktreeList", () => {
  it("parses porcelain output into worktrees", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc1234",
      "branch refs/heads/main",
      "",
      "worktree /home/user/.worktrees/feature-x",
      "HEAD def5678",
      "branch refs/heads/feat/feature-x",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toEqual([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/.worktrees/feature-x", branch: "feat/feature-x" },
    ]);
  });

  it("skips detached HEAD worktrees", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc1234",
      "branch refs/heads/main",
      "",
      "worktree /home/user/.worktrees/detached",
      "HEAD 9999999",
      "detached",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("main");
  });

  it("returns empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("classifyWorktrees", () => {
  const worktrees = [
    { path: "/a", branch: "feat/merged" },
    { path: "/b", branch: "feat/closed" },
    { path: "/c", branch: "feat/open" },
    { path: "/d", branch: "feat/no-pr" },
  ];

  const prMap: Record<string, PrInfo | null> = {
    "feat/merged": { number: 1, state: "MERGED", title: "Merged PR" },
    "feat/closed": { number: 2, state: "CLOSED", title: "Closed PR" },
    "feat/open": { number: 3, state: "OPEN", title: "Open PR" },
    "feat/no-pr": null,
  };

  it("classifies merged and closed as removable", () => {
    const { toRemove, kept } = classifyWorktrees(worktrees, (b) => prMap[b] ?? null);

    expect(toRemove).toHaveLength(2);
    expect(toRemove.map((w) => w.branch)).toEqual(["feat/merged", "feat/closed"]);
  });

  it("keeps open PRs and branches without PRs", () => {
    const { kept } = classifyWorktrees(worktrees, (b) => prMap[b] ?? null);

    expect(kept).toHaveLength(2);
    expect(kept.map((w) => w.branch)).toEqual(["feat/open", "feat/no-pr"]);
  });

  it("returns reason for kept worktrees", () => {
    const { kept } = classifyWorktrees(worktrees, (b) => prMap[b] ?? null);

    expect(kept[0].reason).toBe("PR #3 is OPEN");
    expect(kept[1].reason).toBe("no PR");
  });

  it("returns empty toRemove when all are open", () => {
    const openOnly = [{ path: "/x", branch: "feat/open" }];
    const { toRemove } = classifyWorktrees(openOnly, () => ({
      number: 1,
      state: "OPEN",
      title: "Open",
    }));
    expect(toRemove).toHaveLength(0);
  });
});

describe("port-offset helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-offset-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("portOffsetPath joins the .port-offset filename", () => {
    expect(portOffsetPath("/some/wt")).toBe(join("/some/wt", ".port-offset"));
  });

  it("readPortOffset returns null when the file is absent", () => {
    expect(readPortOffset(dir)).toBeNull();
  });

  it("readPortOffset returns the trimmed offset", () => {
    writeFileSync(portOffsetPath(dir), "12\n");
    expect(readPortOffset(dir)).toBe("12");
  });

  it("readPortOffset returns null for an empty file", () => {
    writeFileSync(portOffsetPath(dir), "  \n");
    expect(readPortOffset(dir)).toBeNull();
  });

  it("deletePortOffset removes the file and reports true", () => {
    writeFileSync(portOffsetPath(dir), "3\n");
    expect(deletePortOffset(dir)).toBe(true);
    expect(existsSync(portOffsetPath(dir))).toBe(false);
  });

  it("deletePortOffset returns false when there is nothing to remove", () => {
    expect(deletePortOffset(dir)).toBe(false);
  });
});
