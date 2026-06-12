// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { runACPSession, selectModel, selectReasoningEffort } from "./acp-client.js";
import type * as acp from "@agentclientprotocol/sdk";
import os from "node:os";

describe("runACPSession", () => {
  const cwd = os.tmpdir();
  const noop = () => {};

  describe("subprocess early exit", () => {
    it("rejects when the agent process exits immediately with non-zero code", async () => {
      // Use a command that exits immediately with code 1
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", "process.exit(1)"],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process exited unexpectedly \(code 1\)/);
    });

    it("rejects when the agent process prints to stderr and exits", async () => {
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", 'console.error("Node.js v24 required"); process.exit(1)'],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process exited unexpectedly/);
    });

    it("rejects when the command is not found", async () => {
      await expect(
        runACPSession("hello", {
          command: "nonexistent-binary-that-does-not-exist",
          args: [],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process failed to start/);
    });
  });

  describe("session timeout", () => {
    it("rejects after the configured timeout", async () => {
      // Use a command that hangs (cat with no input on stdin will block)
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 60000)"],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 200,
        })
      ).rejects.toThrow(/ACP session timed out after 200ms/);
    });
  });
});

describe("selectModel", () => {
  function makeConnection(overrides?: Partial<acp.ClientSideConnection>): acp.ClientSideConnection {
    return {
      unstable_setSessionModel: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
      ...overrides,
    } as unknown as acp.ClientSideConnection;
  }

  function makeSession(overrides?: Partial<acp.NewSessionResponse>): acp.NewSessionResponse {
    return {
      sessionId: "session-1",
      ...overrides,
    } as acp.NewSessionResponse;
  }

  it("calls unstable_setSessionModel when models field is present", async () => {
    const connection = makeConnection();
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [
          { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { modelId: "gpt-5.4", name: "GPT 5.4" },
        ],
      },
    });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "gpt-5.4",
    });
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(logs).toContain('Model set to "gpt-5.4" via session/set_model');
  });

  it("returns the model string on success", async () => {
    const connection = makeConnection();
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [{ modelId: "gpt-5.4", name: "GPT 5.4" }],
      },
    });

    const result = await selectModel(connection, session, "gpt-5.4", () => {});

    expect(result).toBe("gpt-5.4");
  });

  it("logs a warning when the requested model is not in availableModels but still calls set_model", async () => {
    const connection = makeConnection();
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [{ modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }],
      },
    });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "gpt-5.4",
    });
    expect(logs.some((l) => l.includes('not in available models'))).toBe(true);
  });

  it("uses setSessionConfigOption when a model config option is present and models field is absent", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "model-picker", category: "model", name: "Model", currentValue: "claude-sonnet-4.6", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "model-picker",
      value: "gpt-5.4",
    });
    expect(connection.unstable_setSessionModel).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('via session/set_config_option'))).toBe(true);
  });

  it("logs a warning and does nothing when neither models nor model config option is present", async () => {
    const connection = makeConnection();
    const session = makeSession({ configOptions: [] });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.unstable_setSessionModel).not.toHaveBeenCalled();
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('does not advertise model selection capability'))).toBe(true);
  });

  it("logs a warning and continues when unstable_setSessionModel throws", async () => {
    const connection = makeConnection({
      unstable_setSessionModel: vi.fn().mockRejectedValue(new Error("not supported")),
    });
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [{ modelId: "gpt-5.4", name: "GPT 5.4" }],
      },
    });
    const logs: string[] = [];

    await expect(selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('session/set_model failed'))).toBe(true);
  });
});

describe("selectReasoningEffort", () => {
  function makeConnection(overrides?: Partial<acp.ClientSideConnection>): acp.ClientSideConnection {
    return {
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
      ...overrides,
    } as unknown as acp.ClientSideConnection;
  }

  function makeSession(overrides?: Partial<acp.NewSessionResponse>): acp.NewSessionResponse {
    return {
      sessionId: "session-1",
      ...overrides,
    } as acp.NewSessionResponse;
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

    const result = await selectReasoningEffort(connection, session, "low", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(logs.some((l) => l.includes("does not advertise config options"))).toBe(true);
  });

  it("warns when no thought_level config option exists", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "model-picker", category: "model", name: "Model", currentValue: "gpt-4o", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(logs.some((l) => l.includes('does not advertise a "thought_level" config option'))).toBe(true);
  });

  it("warns and returns undefined when setSessionConfigOption throws", async () => {
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
    expect(logs.some((l) => l.includes("session/set_config_option failed"))).toBe(true);
  });
});
