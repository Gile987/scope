// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_NATIVE_CWD_MAX_LENGTH,
  copyNativeTranscriptIfPresent,
  nativeTranscriptPath,
  sanitiseCwdForClaudeNative,
} from "./native-transcript.js";

describe("sanitiseCwdForClaudeNative", () => {
  it("replaces non-alphanumerics with dashes", () => {
    expect(sanitiseCwdForClaudeNative("/tmp/workspaces/project_abc")).toBe("-tmp-workspaces-project-abc");
  });

  it("does not modify already-clean paths beyond casing rules (no lowercase)", () => {
    expect(sanitiseCwdForClaudeNative("foo123BAR")).toBe("foo123BAR");
  });

  it("truncates beyond CLAUDE_NATIVE_CWD_MAX_LENGTH", () => {
    const long = "a".repeat(CLAUDE_NATIVE_CWD_MAX_LENGTH + 50);
    expect(sanitiseCwdForClaudeNative(long).length).toBe(CLAUDE_NATIVE_CWD_MAX_LENGTH);
  });
});

describe("nativeTranscriptPath", () => {
  it("uses CLAUDE_CONFIG_DIR when set", () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/custom/cfg";
    try {
      const p = nativeTranscriptPath({ sessionId: "abc-1", cwd: "/tmp/work" });
      expect(p).toBe("/custom/cfg/projects/-tmp-work/abc-1.jsonl");
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    }
  });

  it("falls back to <home>/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const p = nativeTranscriptPath({ sessionId: "s1", cwd: "/x", home: "/h" });
      expect(p).toBe("/h/.claude/projects/-x/s1.jsonl");
    } finally {
      if (original !== undefined) process.env.CLAUDE_CONFIG_DIR = original;
    }
  });
});

describe("copyNativeTranscriptIfPresent", () => {
  let tmpHome: string;
  let tmpWorkspace: string;
  let tmpArtifacts: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "claude-native-test-"));
    tmpWorkspace = await mkdtemp(join(tmpdir(), "claude-cwd-"));
    tmpArtifacts = await mkdtemp(join(tmpdir(), "claude-artifacts-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(tmpHome, ".claude");
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await Promise.all([
      rm(tmpHome, { recursive: true, force: true }),
      rm(tmpWorkspace, { recursive: true, force: true }),
      rm(tmpArtifacts, { recursive: true, force: true }),
    ]);
  });

  it("copies the transcript when present and returns the destination", async () => {
    const sessionId = "session-xyz";
    const projectDir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", sanitiseCwdForClaudeNative(tmpWorkspace));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), '{"hello":"world"}\n');

    const destination = join(tmpArtifacts, "iteration-1.claude.jsonl");
    const result = await copyNativeTranscriptIfPresent({ sessionId, cwd: tmpWorkspace, destination });

    expect(result).toBe(destination);
    expect(await readFile(destination, "utf8")).toBe('{"hello":"world"}\n');
  });

  it("returns undefined and logs when the source file is missing", async () => {
    const logs: string[] = [];
    const result = await copyNativeTranscriptIfPresent({
      sessionId: "missing",
      cwd: tmpWorkspace,
      destination: join(tmpArtifacts, "iteration-1.claude.jsonl"),
      onLog: (m) => logs.push(m),
    });
    expect(result).toBeUndefined();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/transcript not found at /);
    expect(logs[0]).toMatch(/missing\.jsonl$/);
  });
});
