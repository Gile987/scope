// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  IndependentStrategy,
  BundledStrategy,
  TRAJECTORY_GUIDANCE,
  isWithinWorkspace,
  isWithinAnyRoot,
  JUDGE_AVAILABLE_TOOLS,
  JUDGE_EXCLUDED_TOOLS,
} from "./judge-strategies.js";

/**
 * Test subclass that exposes the protected `createFileTools` so we can assert
 * properties of the judge's workspace-inspection tools without running a real
 * Copilot session.
 */
class TestableStrategy extends IndependentStrategy {
  publicCreateFileTools(
    workspacePath: string,
    opts?: { extraReadRoots?: string[] }
  ) {
    return this.createFileTools(workspacePath, opts);
  }
  publicBuildSessionConfig(tools: any[], systemPrompt: string) {
    return this.buildSessionConfig(tools, systemPrompt);
  }
  publicBuildSystemPrompt(hasTrajectory: boolean) {
    return (this as any).buildSystemPrompt(undefined, hasTrajectory);
  }
  publicBuildUserPrompt(
    criterion: { id: string; prompt: string },
    history: any[] = []
  ) {
    return (this as any).buildUserPrompt(criterion, history);
  }
}

function toolMap(
  workspacePath: string,
  opts?: { extraReadRoots?: string[] }
) {
  const strategy = new TestableStrategy("test-model");
  const tools = strategy.publicCreateFileTools(workspacePath, opts);
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
  args: Record<string, unknown>,
  opts?: { extraReadRoots?: string[] }
): Promise<unknown> {
  const tool = toolMap(workspacePath, opts).get(name);
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

describe("isWithinAnyRoot", () => {
  it("accepts a path inside any of the roots", () => {
    expect(isWithinAnyRoot(["/tmp/ws", "/tmp/spill"], "/tmp/ws/src/a.ts")).toBe(true);
    expect(isWithinAnyRoot(["/tmp/ws", "/tmp/spill"], "/tmp/spill/out.txt")).toBe(true);
    expect(isWithinAnyRoot(["/tmp/ws", "/tmp/spill"], "/tmp/spill")).toBe(true);
  });

  it("rejects a path outside every root (guard preserved per-root)", () => {
    expect(isWithinAnyRoot(["/tmp/ws", "/tmp/spill"], "/tmp/ws2/secret")).toBe(false);
    expect(isWithinAnyRoot(["/tmp/ws", "/tmp/spill"], "/etc/passwd")).toBe(false);
    // sibling-prefix of an allowed root must not slip through
    expect(isWithinAnyRoot(["/tmp/ws", "/tmp/spill"], "/tmp/spill2/x")).toBe(false);
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

describe("judge file tools — extraReadRoots (P10 trajectory spill dir)", () => {
  // The trajectory tools spill oversized outputs to a dir OUTSIDE the workspace
  // and return its absolute path; read_file/file_exists must be able to open it
  // (via extraReadRoots) WITHOUT widening list_directory/search_files, so the
  // codebase view other criteria inspect is never polluted by spill files.
  let parent: string;
  let workspace: string;
  let spill: string;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "judge-spill-"));
    workspace = join(parent, "ws");
    spill = join(parent, "spill");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(spill, { recursive: true });
    writeFileSync(join(workspace, "inside.txt"), "in-workspace");
    writeFileSync(join(spill, "big-output.txt"), "SPILLED OUTPUT");
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("read_file opens an absolute path under an extra read root", async () => {
    const result = (await callTool(
      workspace,
      "read_file",
      { path: join(spill, "big-output.txt") },
      { extraReadRoots: [spill] }
    )) as { content?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("SPILLED OUTPUT");
  });

  it("file_exists confirms a file under an extra read root", async () => {
    const result = (await callTool(
      workspace,
      "file_exists",
      { path: join(spill, "big-output.txt") },
      { extraReadRoots: [spill] }
    )) as { exists?: boolean; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.exists).toBe(true);
  });

  it("read_file still rejects an absolute path outside the workspace AND the extra roots", async () => {
    const outside = join(parent, "other", "secret.txt");
    mkdirSync(join(parent, "other"), { recursive: true });
    writeFileSync(outside, "SECRET");
    const result = (await callTool(
      workspace,
      "read_file",
      { path: outside },
      { extraReadRoots: [spill] }
    )) as { content?: string; error?: string };
    expect(result.error).toBe("Path traversal not allowed");
    expect(result.content).toBeUndefined();
  });

  it("read_file without extraReadRoots rejects the spill path (default behaviour unchanged)", async () => {
    const result = (await callTool(workspace, "read_file", {
      path: join(spill, "big-output.txt"),
    })) as { content?: string; error?: string };
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("list_directory stays workspace-only — it cannot reveal an extra read root's contents", async () => {
    const result = (await callTool(
      workspace,
      "list_directory",
      { path: spill },
      { extraReadRoots: [spill] }
    )) as { entries?: { name: string }[]; error?: string };
    // Whether it errors or resolves the absolute path back under the workspace,
    // it must never surface the spilled file — list_directory ignores extraReadRoots.
    expect(result.entries?.some((e) => e.name === "big-output.txt") ?? false).toBe(false);
  });
});

describe("judge session tool restriction (scope #1117)", () => {
  const strategy = new TestableStrategy("test-model");
  const config = strategy.publicBuildSessionConfig([], "system prompt");

  // The headless judge must never be handed the SDK's built-in execute tools
  // (bash/edit/...). Under mode:"copilot-cli" (the SDK default) those are
  // injected and are NOT skipPermission, so the model trying to run a command
  // itself gets denied with "could not request permission from user" and then
  // mis-reports it as the coder's result. Restricting to custom:* prevents this.
  it("restricts availableTools to custom tools only", () => {
    expect(config.availableTools).toEqual(["custom:*"]);
  });

  it("explicitly excludes built-in and MCP tools", () => {
    expect(config.excludedTools).toEqual(["builtin:*", "mcp:*"]);
  });

  it("never exposes the built-in bash tool to the judge", () => {
    const available = config.availableTools as string[];
    const excluded = config.excludedTools as string[];
    expect(available).not.toContain("builtin:*");
    expect(available).not.toContain("bash");
    // excludedTools wins over availableTools, so builtin:* is hard-disabled.
    expect(excluded).toContain("builtin:*");
  });

  it("uses a replace-mode system message with the provided prompt", () => {
    expect(config.systemMessage).toEqual({ mode: "replace", content: "system prompt" });
  });

  it("exports the filter constants used to build the config", () => {
    expect([...JUDGE_AVAILABLE_TOOLS]).toEqual(["custom:*"]);
    expect([...JUDGE_EXCLUDED_TOOLS]).toEqual(["builtin:*", "mcp:*"]);
  });
});

/**
 * Exposes the protected `buildSystemPrompt` / `buildUserPrompt` so we can assert
 * how captured tool outputs, criteria, and history are surfaced to the judge
 * without running a real Copilot session.
 */
class TestableBundledStrategy extends BundledStrategy {
  publicBuildSystemPrompt(hasTrajectory: boolean) {
    return (this as any).buildSystemPrompt(undefined, hasTrajectory);
  }
  publicBuildUserPrompt(
    criteria: { id: string; prompt: string }[] = [
      { id: "c1", prompt: "does the code work" },
    ],
    history: any[] = []
  ) {
    return (this as any).buildUserPrompt(criteria, history);
  }
}

describe("judge trajectory guidance (issue #1125 / #1156)", () => {
  // The headless judge cannot run commands; it must decide from the codebase
  // plus the coding agent's captured trajectory. The guidance must be generic
  // (not build/test specific) and must tell the judge to treat captured output
  // as authoritative instead of demanding the agent redo or re-prove the work.
  it("is generic, not tied to any one command type", () => {
    const g = TRAJECTORY_GUIDANCE.toLowerCase();
    expect(g).not.toMatch(/build\.log|build_proof|\bnpm run build\b/);
  });

  it("tells the judge it cannot run commands itself", () => {
    expect(TRAJECTORY_GUIDANCE.toLowerCase()).toContain("cannot run any commands");
  });

  it("names the judge's own read-only tools and the unified trajectory tools", () => {
    expect(TRAJECTORY_GUIDANCE).toContain("## Your Tools");
    expect(TRAJECTORY_GUIDANCE).toContain("read_file");
    expect(TRAJECTORY_GUIDANCE).toContain("list_agent_tool_calls");
    expect(TRAJECTORY_GUIDANCE).toContain("get_agent_tool_calls");
    expect(TRAJECTORY_GUIDANCE).toContain("list_agent_tools");
    expect(TRAJECTORY_GUIDANCE).toContain("get_agent_tools");
    expect(TRAJECTORY_GUIDANCE.toLowerCase()).toContain("codebase");
  });

  it("tells the judge to open spilled outputs (responseFile/descriptionFile) with read_file", () => {
    expect(TRAJECTORY_GUIDANCE).toContain("responseFile");
    expect(TRAJECTORY_GUIDANCE).toContain("descriptionFile");
    expect(TRAJECTORY_GUIDANCE.toLowerCase()).toMatch(/open .*with read_file|read_file/);
  });

  it("frames the codebase and captured trajectory as equally authoritative and to be examined together", () => {
    expect(TRAJECTORY_GUIDANCE).toContain("## How to Judge");
    const g = TRAJECTORY_GUIDANCE.toLowerCase();
    expect(g).toContain("equally authoritative");
    expect(g).toContain("examine both");
  });

  it("treats captured output as the record of what happened and forbids redundant re-proving", () => {
    const g = TRAJECTORY_GUIDANCE.toLowerCase();
    expect(g).toContain("record of what happened");
    expect(g).toMatch(/redo or re-prove/);
  });

  it("overrides criteria wording that asks the judge to run commands", () => {
    const g = TRAJECTORY_GUIDANCE.toLowerCase();
    expect(g).toContain("criterion");
    expect(g).toMatch(/run, execute, or re-run/);
    expect(g).toContain("ignore that instruction");
  });

  it("includes the guidance in the system prompt when a trajectory is present", () => {
    const prompt = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(true);
    expect(prompt).toContain(TRAJECTORY_GUIDANCE);
  });

  it("frames What to Evaluate around the agent's work and points at the user message", () => {
    const prompt = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(true);
    expect(prompt).toContain("## What to Evaluate");
    expect(prompt).toMatch(/generated code together with the captured outputs of the tools it ran/);
    expect(prompt).toMatch(/each criterion provided in the user message/);
  });

  it("omits the guidance when no trajectory was captured", () => {
    const prompt = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(false);
    expect(prompt).not.toContain(TRAJECTORY_GUIDANCE);
  });
});

describe("judge system/user prompt split (criteria + history are user data)", () => {
  // The system prompt must stay invariant across criteria/iterations: it carries
  // only the role, tools, judging method, instructions, and output format. The
  // per-request data — the criterion/criteria and previous-iteration history —
  // belongs in the user prompt.

  describe("BundledStrategy", () => {
    const sys = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(true);

    it("keeps the criteria out of the system prompt", () => {
      expect(sys).not.toContain("## Criteria");
      expect(sys).not.toContain("does the code work");
    });

    it("keeps the previous-iteration history out of the system prompt", () => {
      const sysWithHistoryPath = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(false);
      expect(sys).not.toContain("## Previous Iterations");
      expect(sysWithHistoryPath).not.toContain("## Previous Iterations");
    });

    it("puts the criteria in the user prompt", () => {
      const user = new TestableBundledStrategy("test-model").publicBuildUserPrompt();
      expect(user).toContain("## Criteria");
      expect(user).toContain("c1: does the code work");
    });

    it("appends previous-iteration history to the user prompt only when present", () => {
      const strat = new TestableBundledStrategy("test-model");
      const noHistory = strat.publicBuildUserPrompt();
      expect(noHistory).not.toContain("## Previous Iterations");

      const withHistory = strat.publicBuildUserPrompt(
        [{ id: "c1", prompt: "does the code work" }],
        [
          {
            iteration: 1,
            codingAgentResponse: "did some work",
            judgeFeedback: "needs more",
            passed: false,
          },
        ]
      );
      expect(withHistory).toContain("## Previous Iterations");
      expect(withHistory).toContain("### Iteration 1");
    });
  });

  describe("IndependentStrategy", () => {
    const strat = new TestableStrategy("test-model");
    const sys = strat.publicBuildSystemPrompt(true);

    it("keeps the criterion out of the system prompt", () => {
      expect(sys).not.toContain("**Criterion**");
      expect(sys).toMatch(/the criterion provided in the user message/);
    });

    it("keeps the previous-iteration history out of the system prompt", () => {
      expect(sys).not.toContain("## Previous Iterations");
    });

    it("puts the criterion id and prompt in the user prompt", () => {
      const user = strat.publicBuildUserPrompt({ id: "build-ok", prompt: "it builds" });
      expect(user).toContain('Evaluate criterion "build-ok": it builds');
    });

    it("appends previous-iteration history to the user prompt only when present", () => {
      const noHistory = strat.publicBuildUserPrompt({ id: "build-ok", prompt: "it builds" });
      expect(noHistory).not.toContain("## Previous Iterations");

      const withHistory = strat.publicBuildUserPrompt(
        { id: "build-ok", prompt: "it builds" },
        [{ iteration: 1, codingAgentResponse: "tried", passed: false }]
      );
      expect(withHistory).toContain("## Previous Iterations (for context)");
      expect(withHistory).toContain("### Iteration 1");
    });
  });
});
