// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  countTrailingZeros,
  validateBasePorts,
  parseEnvBase,
  findLowestUnusedOffset,
  computeWorktreeEnv,
  updateEnvFile,
} from "./worktree-env.js";

// --- countTrailingZeros ------------------------------------------------------

describe("countTrailingZeros", () => {
  it("returns 3 for 27000", () => expect(countTrailingZeros(27000)).toBe(3));
  it("returns 2 for 6300", () => expect(countTrailingZeros(6300)).toBe(2));
  it("returns 2 for 10100", () => expect(countTrailingZeros(10100)).toBe(2));
  it("returns 1 for 3140", () => expect(countTrailingZeros(3140)).toBe(1));
  it("returns 0 for 3141", () => expect(countTrailingZeros(3141)).toBe(0));
  it("returns 0 for 18897", () => expect(countTrailingZeros(18897)).toBe(0));
  it("returns 2 for 18800", () => expect(countTrailingZeros(18800)).toBe(2));
});

// --- validateBasePorts -------------------------------------------------------

describe("validateBasePorts", () => {
  it("returns no errors/warnings for ports with 2+ trailing zeros", () => {
    const ports = [
      { name: "API_PORT", base: 3100 },
      { name: "MONGODB_PORT", base: 27000 },
    ];
    const { errors, warnings } = validateBasePorts(ports);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("returns warning for port with 1 trailing zero", () => {
    const ports = [{ name: "API_PORT", base: 3140 }];
    const { errors, warnings } = validateBasePorts(ports);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("only 1 trailing zero");
  });

  it("returns error for port with no trailing zeros", () => {
    const ports = [{ name: "API_PORT", base: 3141 }];
    const { errors, warnings } = validateBasePorts(ports);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no trailing zeros");
    expect(warnings).toHaveLength(0);
  });
});

// --- parseEnvBase ------------------------------------------------------------

describe("parseEnvBase", () => {
  it("parses valid lines", () => {
    const content = `
# comment
MONGODB_PORT=27000
REDIS_PORT=6300
`;
    const result = parseEnvBase(content);
    expect(result).toEqual([
      { name: "MONGODB_PORT", base: 27000 },
      { name: "REDIS_PORT", base: 6300 },
    ]);
  });

  it("skips empty lines and comments", () => {
    const content = `
# a comment

MONGODB_PORT=27000
`;
    const result = parseEnvBase(content);
    expect(result).toHaveLength(1);
  });
});

// --- findLowestUnusedOffset --------------------------------------------------

describe("findLowestUnusedOffset", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "worktree-env-test-"));
    mkdirSync(join(sandbox, "wt-a"), { recursive: true });
    mkdirSync(join(sandbox, "wt-b"), { recursive: true });
    mkdirSync(join(sandbox, "wt-c"), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns 1 when no offsets exist", () => {
    expect(findLowestUnusedOffset(sandbox, "wt-a")).toBe(1);
  });

  it("returns 2 when offset 1 is taken", () => {
    writeFileSync(join(sandbox, "wt-b", ".port-offset"), "1\n");
    expect(findLowestUnusedOffset(sandbox, "wt-a")).toBe(2);
  });

  it("fills gaps — returns 1 when 2 and 3 are taken", () => {
    writeFileSync(join(sandbox, "wt-b", ".port-offset"), "2\n");
    writeFileSync(join(sandbox, "wt-c", ".port-offset"), "3\n");
    expect(findLowestUnusedOffset(sandbox, "wt-a")).toBe(1);
  });

  it("skips current worktree's offset file", () => {
    writeFileSync(join(sandbox, "wt-a", ".port-offset"), "1\n");
    // wt-a's own file is excluded, so lowest is 1 again if no others
    expect(findLowestUnusedOffset(sandbox, "wt-a")).toBe(1);
  });

  it("returns next after all consecutive taken", () => {
    writeFileSync(join(sandbox, "wt-a", ".port-offset"), "1\n");
    writeFileSync(join(sandbox, "wt-b", ".port-offset"), "2\n");
    writeFileSync(join(sandbox, "wt-c", ".port-offset"), "3\n");
    // New worktree "wt-d" (not in sandbox yet, but that's fine)
    expect(findLowestUnusedOffset(sandbox, "wt-d")).toBe(4);
  });
});

// --- computeWorktreeEnv ------------------------------------------------------

describe("computeWorktreeEnv", () => {
  let sandbox: string;

  const basePorts = [
    { name: "MONGODB_PORT", base: 27000 },
    { name: "REDIS_PORT", base: 6300 },
    { name: "API_PORT", base: 3100 },
  ];

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "worktree-env-test-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns offset 0 for main repo (not inside .worktrees/)", () => {
    const result = computeWorktreeEnv(sandbox, basePorts);
    expect(result.offset).toBe(0);
    expect(result.worktreeName).toBeNull();
    expect(result.composeProjectName).toBe("scope-mt-app");
    expect(result.ports.MONGODB_PORT).toBe(27000);
    expect(result.ports.REDIS_PORT).toBe(6300);
    expect(result.ports.API_PORT).toBe(3100);
  });

  it("assigns offset 1 for first worktree", () => {
    const worktreesDir = join(sandbox, ".worktrees");
    const wtDir = join(worktreesDir, "my-feature");
    mkdirSync(wtDir, { recursive: true });

    const result = computeWorktreeEnv(wtDir, basePorts);
    expect(result.offset).toBe(1);
    expect(result.worktreeName).toBe("my-feature");
    expect(result.composeProjectName).toBe("scope-mt-app-my-feature");
    expect(result.ports.MONGODB_PORT).toBe(27001);
    expect(result.ports.REDIS_PORT).toBe(6301);
    expect(result.ports.API_PORT).toBe(3101);

    // .port-offset written
    expect(readFileSync(join(wtDir, ".port-offset"), "utf-8").trim()).toBe("1");
  });

  it("reuses existing .port-offset", () => {
    const worktreesDir = join(sandbox, ".worktrees");
    const wtDir = join(worktreesDir, "my-feature");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, ".port-offset"), "5\n");

    const result = computeWorktreeEnv(wtDir, basePorts);
    expect(result.offset).toBe(5);
    expect(result.ports.API_PORT).toBe(3105);
  });

  it("assigns next available offset when others are taken", () => {
    const worktreesDir = join(sandbox, ".worktrees");
    const wtA = join(worktreesDir, "wt-a");
    const wtB = join(worktreesDir, "wt-b");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    writeFileSync(join(wtA, ".port-offset"), "1\n");

    const result = computeWorktreeEnv(wtB, basePorts);
    expect(result.offset).toBe(2);
  });

  it("recycles gap offsets", () => {
    const worktreesDir = join(sandbox, ".worktrees");
    const wtA = join(worktreesDir, "wt-a");
    const wtB = join(worktreesDir, "wt-b");
    const wtC = join(worktreesDir, "wt-c");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    mkdirSync(wtC, { recursive: true });
    // offsets 2 and 3 are taken (1 is free)
    writeFileSync(join(wtA, ".port-offset"), "2\n");
    writeFileSync(join(wtB, ".port-offset"), "3\n");

    const result = computeWorktreeEnv(wtC, basePorts);
    expect(result.offset).toBe(1);
  });

  it("throws when offset exceeds available range", () => {
    const worktreesDir = join(sandbox, ".worktrees");
    // Use a port with only 1 trailing zero (max offset 9)
    const tightPorts = [{ name: "TIGHT_PORT", base: 3140 }];

    // Create 9 worktrees taking offsets 1-9
    for (let i = 1; i <= 9; i++) {
      const dir = join(worktreesDir, `wt-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".port-offset"), `${i}\n`);
    }
    const wtNew = join(worktreesDir, "wt-new");
    mkdirSync(wtNew, { recursive: true });

    expect(() => computeWorktreeEnv(wtNew, tightPorts)).toThrow(
      /exceeds available range/
    );
  });
});

// --- updateEnvFile -----------------------------------------------------------

describe("updateEnvFile", () => {
  let sandbox: string;

  const result = {
    worktreeName: "my-feature",
    offset: 1,
    ports: { API_PORT: 3101, MONGODB_PORT: 27001 } as Record<string, number>,
    composeProjectName: "scope-mt-app-my-feature",
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "worktree-env-test-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("creates .env when it doesn't exist", () => {
    const envPath = join(sandbox, ".env");
    updateEnvFile(envPath, result);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("BEGIN managed by worktree-env.sh");
    expect(content).toContain("END managed by worktree-env.sh");
    expect(content).toContain("COMPOSE_PROJECT_NAME=scope-mt-app-my-feature");
    expect(content).toContain("API_PORT=3101");
    expect(content).toContain("MONGODB_PORT=27001");
  });

  it("appends managed block to existing .env without markers", () => {
    const envPath = join(sandbox, ".env");
    writeFileSync(envPath, "MY_VAR=hello\n");
    updateEnvFile(envPath, result);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("MY_VAR=hello");
    expect(content).toContain("API_PORT=3101");
  });

  it("replaces managed block preserving content above", () => {
    const envPath = join(sandbox, ".env");
    writeFileSync(
      envPath,
      `MY_VAR=hello
# --- BEGIN managed by worktree-env.sh (do not edit) ---
OLD_CONTENT=stale
# --- END managed by worktree-env.sh ---
`
    );
    updateEnvFile(envPath, result);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("MY_VAR=hello");
    expect(content).not.toContain("OLD_CONTENT=stale");
    expect(content).toContain("API_PORT=3101");
  });

  it("preserves content below the END marker", () => {
    const envPath = join(sandbox, ".env");
    writeFileSync(
      envPath,
      `ABOVE=1
# --- BEGIN managed by worktree-env.sh (do not edit) ---
OLD=stale
# --- END managed by worktree-env.sh ---
BELOW=2
`
    );
    updateEnvFile(envPath, result);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ABOVE=1");
    expect(content).toContain("BELOW=2");
    expect(content).not.toContain("OLD=stale");
    expect(content).toContain("API_PORT=3101");
  });

  it("is idempotent — running twice produces same result", () => {
    const envPath = join(sandbox, ".env");
    updateEnvFile(envPath, result);
    const first = readFileSync(envPath, "utf-8");
    updateEnvFile(envPath, result);
    const second = readFileSync(envPath, "utf-8");
    expect(first).toBe(second);
  });
});
