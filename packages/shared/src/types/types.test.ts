// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { WorkerProcessor, WorkerProcessorOptions, LogEvent, CodingAgentDocument } from "./types.js";

describe("WorkerProcessorOptions", () => {
  it("passes model through processMessage", async () => {
    const receivedOptions: WorkerProcessorOptions[] = [];

    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(
        _message: string,
        _log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
        options?: WorkerProcessorOptions
      ): Promise<string> {
        if (options) receivedOptions.push(options);
        return "done";
      },
    };

    const log = vi.fn();

    await processor.processMessage("task", log, { model: "gpt-4.1" });
    expect(receivedOptions).toHaveLength(1);
    expect(receivedOptions[0].model).toBe("gpt-4.1");
  });

  it("allows processMessage without options", async () => {
    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<string> {
        return "done";
      },
    };

    const log = vi.fn();
    const result = await processor.processMessage("task", log);
    expect(result).toBe("done");
  });

  it("allows processMessage with undefined model", async () => {
    let receivedModel: string | undefined = "not-set";

    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(
        _message: string,
        _log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
        options?: WorkerProcessorOptions
      ): Promise<string> {
        receivedModel = options?.model;
        return "done";
      },
    };

    const log = vi.fn();
    await processor.processMessage("task", log, {});
    expect(receivedModel).toBeUndefined();
  });
});

describe("CodingAgentDocument", () => {
  it("supports all required fields", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "Copilot (ACP)",
      supportedModels: ["gpt-4.1", "claude-sonnet-4"],
      defaultModel: "gpt-4.1",
      createdAt: new Date(),
    };

    expect(agent._id).toBe("coder-acp-copilot");
    expect(agent.name).toBe("Copilot (ACP)");
    expect(agent.supportedModels).toEqual(["gpt-4.1", "claude-sonnet-4"]);
    expect(agent.defaultModel).toBe("gpt-4.1");
    expect(agent.deletedAt).toBeUndefined();
  });

  it("supports empty supportedModels (model selection disabled)", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "VS Code Web",
      supportedModels: [],
      createdAt: new Date(),
    };

    expect(agent.supportedModels).toEqual([]);
    expect(agent.defaultModel).toBeUndefined();
  });

  it("supports soft-delete with deletedAt", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-claude-code",
      name: "Claude Code (ACP)",
      supportedModels: ["claude-sonnet-4"],
      defaultModel: "claude-sonnet-4",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-06-01"),
      deletedAt: new Date("2025-06-15"),
    };

    expect(agent.deletedAt).toBeInstanceOf(Date);
  });

  it("validates defaultModel is in supportedModels (application-level check)", () => {
    const agent: CodingAgentDocument = {
      _id: "test-agent",
      name: "Test Agent",
      supportedModels: ["model-a", "model-b"],
      defaultModel: "model-a",
      createdAt: new Date(),
    };

    // Application-level validation: defaultModel should be in supportedModels
    expect(agent.supportedModels).toContain(agent.defaultModel);
  });
});
