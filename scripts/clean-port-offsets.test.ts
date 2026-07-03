// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  selectReclaimable,
  parseArgs,
  parsePrList,
  type WorktreeState,
  type PrRef,
} from "./clean-port-offsets.js";

/** Build a WorktreeState with sensible reclaimable defaults, overridable. */
function state(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    path: "/wt/a",
    branch: "feat/a",
    offset: "7",
    commitsAhead: 0,
    dirty: false,
    isPrimary: false,
    isCurrent: false,
    pr: null,
    ...overrides,
  };
}

const pr = (state: PrRef["state"], number = 1): PrRef => ({ number, state });

describe("selectReclaimable", () => {
  it("frees a merged/empty, clean, non-primary, non-current worktree with an offset", () => {
    const { toFree, kept } = selectReclaimable([state()]);
    expect(kept).toHaveLength(0);
    expect(toFree).toHaveLength(1);
    expect(toFree[0]).toMatchObject({ branch: "feat/a", offset: "7" });
  });

  it("keeps the primary checkout", () => {
    const { toFree, kept } = selectReclaimable([state({ isPrimary: true })]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("primary checkout");
  });

  it("keeps the current worktree", () => {
    const { toFree, kept } = selectReclaimable([state({ isCurrent: true })]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("current worktree");
  });

  it("keeps a worktree with no .port-offset", () => {
    const { toFree, kept } = selectReclaimable([state({ offset: null })]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("no .port-offset");
  });

  it("keeps a worktree with unmerged commits and no PR (local WIP)", () => {
    const { toFree, kept } = selectReclaimable([state({ commitsAhead: 3 })]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("3 unmerged commit(s)");
  });

  it("keeps a worktree with an unknown (infinite) commit count", () => {
    const { toFree, kept } = selectReclaimable([
      state({ commitsAhead: Number.POSITIVE_INFINITY }),
    ]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("? unmerged commit(s)");
  });

  it("keeps a worktree with a dirty working tree (protects active sessions)", () => {
    const { toFree, kept } = selectReclaimable([state({ dirty: true })]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("uncommitted changes");
  });

  // --- PR-state veto (safety) ------------------------------------------------

  it("keeps a worktree with an OPEN PR even when git state looks done (0 ahead, clean)", () => {
    // Scenario: reset-but-still-open PR. git state alone would wrongly free it.
    const { toFree, kept } = selectReclaimable([
      state({ commitsAhead: 0, dirty: false, pr: pr("open", 42) }),
    ]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("open PR #42");
  });

  it("open PR veto beats commits and everything else", () => {
    const { toFree, kept } = selectReclaimable([
      state({ commitsAhead: 9, dirty: true, pr: pr("open", 7) }),
    ]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("open PR #7");
  });

  // --- PR-state reclaim (reach) ----------------------------------------------

  it("frees a MERGED-PR worktree even when it still holds commits", () => {
    const { toFree, kept } = selectReclaimable([
      state({ commitsAhead: 4, pr: pr("merged", 100) }),
    ]);
    expect(kept).toHaveLength(0);
    expect(toFree).toHaveLength(1);
    expect(toFree[0].reason).toBe("merged PR #100");
  });

  it("frees a CLOSED-PR worktree even when it still holds commits", () => {
    const { toFree, kept } = selectReclaimable([
      state({ commitsAhead: 2, pr: pr("closed", 55) }),
    ]);
    expect(kept).toHaveLength(0);
    expect(toFree).toHaveLength(1);
    expect(toFree[0].reason).toBe("closed PR #55");
  });

  it("keeps a merged/closed-PR worktree that has uncommitted changes (dirty veto wins)", () => {
    const { toFree, kept } = selectReclaimable([
      state({ dirty: true, commitsAhead: 4, pr: pr("merged", 100) }),
    ]);
    expect(toFree).toHaveLength(0);
    expect(kept[0].reason).toBe("uncommitted changes");
  });

  // --- git-state fallback ----------------------------------------------------

  it("falls back to git state when no PR matches: frees 0-ahead + clean", () => {
    const { toFree } = selectReclaimable([state({ pr: null, commitsAhead: 0 })]);
    expect(toFree).toHaveLength(1);
    expect(toFree[0].reason).toBe("no commits ahead of base");
  });

  it("partitions a mixed set correctly", () => {
    const { toFree, kept } = selectReclaimable([
      state({ path: "/wt/free1", branch: "merged-reset", offset: "10" }),
      state({ path: "/wt/free2", branch: "closed-pr", offset: "11", commitsAhead: 3, pr: pr("closed", 5) }),
      state({ path: "/wt/free3", branch: "merged-pr", offset: "12", commitsAhead: 8, pr: pr("merged", 6) }),
      state({ path: "/wt/keep1", branch: "open-pr", offset: "13", commitsAhead: 0, pr: pr("open", 7) }),
      state({ path: "/wt/keep2", branch: "wip", offset: "14", dirty: true }),
      state({ path: "/wt/keep3", branch: "local", offset: "15", commitsAhead: 2 }),
      state({ path: "/wt/keep4", branch: "no-offset", offset: null }),
      state({ path: "/wt/main", branch: "main", isPrimary: true }),
    ]);
    expect(toFree.map((w) => w.branch).sort()).toEqual([
      "closed-pr",
      "merged-pr",
      "merged-reset",
    ]);
    expect(kept).toHaveLength(5);
  });

  it("returns empty plan for empty input", () => {
    expect(selectReclaimable([])).toEqual({ toFree: [], kept: [] });
  });
});

describe("parsePrList", () => {
  it("indexes PRs by head branch and normalizes state to lowercase", () => {
    const map = parsePrList(
      JSON.stringify([
        { number: 1, headRefName: "feat/a", state: "OPEN" },
        { number: 2, headRefName: "feat/b", state: "MERGED" },
        { number: 3, headRefName: "feat/c", state: "CLOSED" },
      ]),
    );
    expect(map.get("feat/a")).toEqual({ number: 1, state: "open" });
    expect(map.get("feat/b")).toEqual({ number: 2, state: "merged" });
    expect(map.get("feat/c")).toEqual({ number: 3, state: "closed" });
  });

  it("prefers an OPEN PR when several share a branch name", () => {
    const map = parsePrList(
      JSON.stringify([
        { number: 1, headRefName: "shared", state: "CLOSED" },
        { number: 2, headRefName: "shared", state: "OPEN" },
        { number: 3, headRefName: "shared", state: "MERGED" },
      ]),
    );
    expect(map.get("shared")).toEqual({ number: 2, state: "open" });
  });

  it("keeps the first seen when no OPEN PR shares the branch", () => {
    const map = parsePrList(
      JSON.stringify([
        { number: 9, headRefName: "dup", state: "MERGED" },
        { number: 8, headRefName: "dup", state: "CLOSED" },
      ]),
    );
    expect(map.get("dup")).toEqual({ number: 9, state: "merged" });
  });

  it("ignores malformed entries and unknown states", () => {
    const map = parsePrList(
      JSON.stringify([
        { number: 1, headRefName: "ok", state: "OPEN" },
        { headRefName: "no-number", state: "OPEN" },
        { number: 2, state: "OPEN" },
        { number: 3, headRefName: "weird", state: "DRAFTED" },
      ]),
    );
    expect(map.size).toBe(1);
    expect(map.get("ok")).toEqual({ number: 1, state: "open" });
  });

  it("returns an empty map for invalid or non-array JSON", () => {
    expect(parsePrList("not json").size).toBe(0);
    expect(parsePrList("{}").size).toBe(0);
    expect(parsePrList("[]").size).toBe(0);
  });
});

describe("parseArgs", () => {
  it("returns sensible defaults (fetch on)", () => {
    expect(parseArgs([])).toEqual({ yes: false, dryRun: false, fetch: true });
  });

  it("parses --yes and -y", () => {
    expect(parseArgs(["--yes"]).yes).toBe(true);
    expect(parseArgs(["-y"]).yes).toBe(true);
  });

  it("parses --dry-run and -n", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["-n"]).dryRun).toBe(true);
  });

  it("parses --no-fetch", () => {
    expect(parseArgs(["--no-fetch"]).fetch).toBe(false);
  });

  it("parses combined flags", () => {
    expect(parseArgs(["-y", "-n", "--no-fetch"])).toEqual({
      yes: true,
      dryRun: true,
      fetch: false,
    });
  });
});
