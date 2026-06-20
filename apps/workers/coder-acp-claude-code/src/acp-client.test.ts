// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACPClientHandler, selectReasoningEffort, formatToolArgs } from "./acp-client.js";

describe("formatToolArgs", () => {
  it("returns an empty string for non-object input", () => {
    expect(formatToolArgs(undefined)).toBe("");
    expect(formatToolArgs(null)).toBe("");
    expect(formatToolArgs("hello")).toBe("");
  });

  it("returns an empty string for an empty object", () => {
    expect(formatToolArgs({})).toBe("");
  });

  it("formats arguments as key=value pairs with collapsed whitespace", () => {
    expect(formatToolArgs({ command: "npm   install", path: "src" })).toBe(
      "command=npm install, path=src"
    );
  });

  it("truncates long previews with an ellipsis", () => {
    const result = formatToolArgs({ path: "a".repeat(300) }, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("ACPClientHandler tool call logging", () => {
  let workspace: string;
  let logs: string[];
  let handler: ACPClientHandler;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "acp-tool-log-"));
    logs = [];
    handler = new ACPClientHandler((msg) => logs.push(msg), workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("logs a tool call with an argument preview", async () => {
    await handler.sessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_bdrk_123",
        title: "Create Astro project",
        status: "pending",
        kind: "execute",
        rawInput: { command: "npm create astro@latest" },
      },
    } as never);

    expect(logs).toEqual([
      "Tool call: [execute] Create Astro project command=npm create astro@latest (pending)",
    ]);
  });

  it("shows the title (not the opaque id) and carries kind forward on updates", async () => {
    await handler.sessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_bdrk_123",
        title: "Create Astro project",
        status: "pending",
        kind: "execute",
      },
    } as never);
    logs.length = 0;

    await handler.sessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bdrk_123",
        status: "completed",
      },
    } as never);

    expect(logs).toEqual(["Tool update: [execute] Create Astro project - completed"]);
  });

  it("falls back to the tool call id when no title was seen", async () => {
    await handler.sessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bdrk_unknown",
        status: "completed",
      },
    } as never);

    expect(logs).toEqual(["Tool update: toolu_bdrk_unknown - completed"]);
  });
});

describe("ACPClientHandler", () => {
  let workspace: string;
  let logs: string[];
  let handler: ACPClientHandler;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "acp-test-"));
    logs = [];
    handler = new ACPClientHandler((msg) => logs.push(msg), workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  describe("writeTextFile", () => {
    it("writes content to a relative path", async () => {
      await handler.writeTextFile({
        path: "app.py",
        content: "print('hello')",
        sessionId: "test-session",
      });

      const written = readFileSync(join(workspace, "app.py"), "utf-8");
      expect(written).toBe("print('hello')");
    });

    it("creates nested parent directories", async () => {
      await handler.writeTextFile({
        path: "src/lib/utils.ts",
        content: "export const x = 1;",
        sessionId: "test-session",
      });

      const written = readFileSync(join(workspace, "src/lib/utils.ts"), "utf-8");
      expect(written).toBe("export const x = 1;");
    });

    it("overwrites existing files", async () => {
      const filePath = join(workspace, "file.txt");
      writeFileSync(filePath, "old content");

      await handler.writeTextFile({
        path: "file.txt",
        content: "new content",
        sessionId: "test-session",
      });

      expect(readFileSync(filePath, "utf-8")).toBe("new content");
    });

    it("writes absolute paths within workspace", async () => {
      const absPath = join(workspace, "abs-file.txt");

      await handler.writeTextFile({
        path: absPath,
        content: "absolute write",
        sessionId: "test-session",
      });

      expect(readFileSync(absPath, "utf-8")).toBe("absolute write");
    });

    it("logs the write with character count", async () => {
      await handler.writeTextFile({
        path: "readme.md",
        content: "# Hello",
        sessionId: "test-session",
      });

      expect(logs).toContainEqual("Write file: readme.md (7 chars)");
    });

    it("handles empty content", async () => {
      await handler.writeTextFile({
        path: "empty.txt",
        content: "",
        sessionId: "test-session",
      });

      expect(readFileSync(join(workspace, "empty.txt"), "utf-8")).toBe("");
      expect(logs).toContainEqual("Write file: empty.txt (0 chars)");
    });
  });

  describe("readTextFile", () => {
    it("reads existing file content", async () => {
      writeFileSync(join(workspace, "data.txt"), "file content");

      const result = await handler.readTextFile({
        path: "data.txt",
        sessionId: "test-session",
      });

      expect(result.content).toBe("file content");
    });

    it("returns empty string for non-existent file", async () => {
      const result = await handler.readTextFile({
        path: "missing.txt",
        sessionId: "test-session",
      });

      expect(result.content).toBe("");
    });

    it("reads from nested paths", async () => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src/index.ts"), "export {}");

      const result = await handler.readTextFile({
        path: "src/index.ts",
        sessionId: "test-session",
      });

      expect(result.content).toBe("export {}");
    });

    it("reads file written by writeTextFile", async () => {
      await handler.writeTextFile({
        path: "round-trip.txt",
        content: "round trip content",
        sessionId: "test-session",
      });

      const result = await handler.readTextFile({
        path: "round-trip.txt",
        sessionId: "test-session",
      });

      expect(result.content).toBe("round trip content");
    });

    it("logs the read", async () => {
      writeFileSync(join(workspace, "log-test.txt"), "x");

      await handler.readTextFile({
        path: "log-test.txt",
        sessionId: "test-session",
      });

      expect(logs).toContainEqual("Read file: log-test.txt");
    });
  });

  describe("path traversal protection", () => {
    it("blocks absolute paths outside workspace", async () => {
      await expect(
        handler.writeTextFile({
          path: "/etc/passwd",
          content: "malicious",
          sessionId: "test-session",
        })
      ).rejects.toThrow("Path traversal blocked");
    });

    it("blocks relative paths that escape workspace", async () => {
      await expect(
        handler.writeTextFile({
          path: "../../etc/shadow",
          content: "malicious",
          sessionId: "test-session",
        })
      ).rejects.toThrow("Path traversal blocked");
    });

    it("blocks traversal on readTextFile too", async () => {
      await expect(
        handler.readTextFile({
          path: "../../../etc/hostname",
          sessionId: "test-session",
        })
      ).rejects.toThrow("Path traversal blocked");
    });

    it("allows paths that contain .. but stay within workspace", async () => {
      mkdirSync(join(workspace, "a/b"), { recursive: true });

      await handler.writeTextFile({
        path: "a/b/../c.txt",
        content: "ok",
        sessionId: "test-session",
      });

      expect(readFileSync(join(workspace, "a/c.txt"), "utf-8")).toBe("ok");
    });
  });
});

describe("selectReasoningEffort", () => {
  function makeConnection(overrides?: Record<string, unknown>) {
    return {
      setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  function makeSession(overrides?: Record<string, unknown>) {
    return {
      sessionId: "session-1",
      ...overrides,
    } as any;
  }

  it("sets effort via setSessionConfigOption when thought_level config option exists", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "reasoning_effort", category: "thought_level", name: "Reasoning Effort", currentValue: "medium", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "reasoning_effort",
      value: "high",
    });
    expect(result).toBe("high");
    expect(logs).toContain('Reasoning effort set to "high" via session/set_config_option (configId: reasoning_effort)');
  });

  it("warns when configOptions is undefined", async () => {
    const connection = makeConnection();
    const session = makeSession({ configOptions: undefined });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(result).toBeUndefined();
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(logs[0]).toContain("does not advertise config options");
    expect(logs[0]).toContain('"high"');
  });

  it("warns when no thought_level config option is found and lists available options", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "model_selector", category: "model", name: "Model", currentValue: "claude-sonnet", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "medium", (msg) => logs.push(msg));

    expect(result).toBeUndefined();
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(logs[0]).toContain('does not advertise a "thought_level" config option');
    expect(logs[0]).toContain("model_selector (category: model)");
  });

  it("warns and returns undefined on RPC error", async () => {
    const connection = makeConnection({
      setSessionConfigOption: vi.fn().mockRejectedValue(new Error("config not writable")),
    });
    const session = makeSession({
      configOptions: [
        { id: "reasoning_effort", category: "thought_level", name: "Reasoning Effort", currentValue: "medium", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(result).toBeUndefined();
    expect(logs[0]).toContain("session/set_config_option failed");
    expect(logs[0]).toContain("config not writable");
  });
});
