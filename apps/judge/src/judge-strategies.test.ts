// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IndependentStrategy, isWithinWorkspace } from "./judge-strategies.js";

/**
 * Test subclass that exposes the protected `createFileTools` so we can assert
 * properties of the judge's workspace-inspection tools without running a real
 * Copilot session.
 */
class TestableStrategy extends IndependentStrategy {
  publicCreateFileTools(workspacePath: string) {
    return this.createFileTools(workspacePath);
  }
}

function toolMap(workspacePath: string) {
  const strategy = new TestableStrategy("test-model");
  const tools = strategy.publicCreateFileTools(workspacePath);
  return new Map(tools.map((t) => [t.name, t]));
}

const stubInvocation = {
  sessionId: "test-session",
  toolCallId: "test-call",
  toolName: "test-tool",
  arguments: {},
};

async function callTool(
  workspacePath: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = toolMap(workspacePath).get(name);
  if (!tool?.handler) throw new Error(`tool ${name} has no handler`);
  return (tool.handler as (a: unknown, b: unknown) => unknown)(args, stubInvocation);
}

describe("judge file tools", () => {
  const strategy = new TestableStrategy("test-model");
  const tools = strategy.publicCreateFileTools("/tmp/workspace");

  it("exposes the expected read-only inspection tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["file_exists", "list_directory", "read_file", "search_files"].sort()
    );
  });

  // Regression guard for scope-doc#64: under the v3 Copilot SDK the headless
  // judge cannot answer interactive permission prompts, so any tool without
  // skipPermission is denied at execution time ("could not request permission
  // from user"), silently breaking all workspace inspection.
  it("marks every tool to skip the permission prompt", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.skipPermission, `${tool.name} must skip the permission prompt`).toBe(true);
    }
  });
});

describe("isWithinWorkspace", () => {
  it("accepts the root itself and nested paths", () => {
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws")).toBe(true);
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws/src/index.ts")).toBe(true);
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws/a/../b")).toBe(true);
  });

  it("rejects sibling directories that share a name prefix", () => {
    // The bug a plain startsWith() check would miss: /tmp/ws2 is NOT under /tmp/ws.
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws2")).toBe(false);
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws2/secret")).toBe(false);
  });

  it("rejects parent-traversal escapes", () => {
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws/../ws2/secret")).toBe(false);
    expect(isWithinWorkspace("/tmp/ws", "/tmp")).toBe(false);
    expect(isWithinWorkspace("/tmp/ws", "/etc/passwd")).toBe(false);
  });
});

describe("judge file tool handlers (workspace scoping)", () => {
  let parent: string;
  let workspace: string;
  let sibling: string;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "judge-tools-"));
    // Sibling shares the "ws" name prefix to exercise the boundary check.
    workspace = join(parent, "ws");
    sibling = join(parent, "ws2");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(workspace, "inside.txt"), "in-workspace");
    writeFileSync(join(sibling, "secret.txt"), "SECRET");
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("read_file refuses to read a sibling-prefix path via ..", async () => {
    const result = (await callTool(workspace, "read_file", {
      path: "../ws2/secret.txt",
    })) as { error?: string; content?: string };
    expect(result.error).toBe("Path traversal not allowed");
    expect(result.content).toBeUndefined();
  });

  it("read_file reads a legitimate in-workspace file", async () => {
    const result = (await callTool(workspace, "read_file", {
      path: "inside.txt",
    })) as { content?: string };
    expect(result.content).toBe("in-workspace");
  });

  it("file_exists refuses a sibling-prefix path", async () => {
    const result = (await callTool(workspace, "file_exists", {
      path: "../ws2/secret.txt",
    })) as { error?: string };
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("list_directory refuses a sibling-prefix path", async () => {
    const result = (await callTool(workspace, "list_directory", {
      path: "../ws2",
    })) as { error?: string };
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("search_files does not execute shell metacharacters in the pattern", async () => {
    const marker = join(parent, "pwned");
    // If the pattern were interpolated into a shell, $(...) would create the file.
    await callTool(workspace, "search_files", { pattern: `$(touch ${marker})` });
    expect(existsSync(marker)).toBe(false);
  });

  it("search_files finds real matches in the workspace", async () => {
    const result = (await callTool(workspace, "search_files", {
      pattern: "in-workspace",
    })) as { matches: string[] };
    expect(result.matches.some((m) => m.includes("inside.txt"))).toBe(true);
  });
});
