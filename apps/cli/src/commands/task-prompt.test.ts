// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerTaskPromptCommands } from "./task-prompt.js";

function makeProgram(): Command {
  const program = new Command();
  registerTaskPromptCommands(program);
  return program;
}

function mockFetchWith(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("task-prompt list", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes --type as a query param", async () => {
    mockFetchWith({ items: [], total: 0 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "list", "--type", "agents.md", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    const url = fetchMock().mock.calls[0][0] as string;
    expect(url).toContain("type=agents.md");
  });

  it("renders blob-backed prompts without crashing on missing text", async () => {
    mockFetchWith({
      items: [{ _id: "abcdef1234", type: "agents.md", contentBlobUrl: "prompts/abcdef1234.txt", createdAt: new Date().toISOString() }],
      total: 1,
    });
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      lines.push(p.map(String).join(" "));
    });

    try {
      const program = makeProgram();
      await program.parseAsync(["task-prompt", "list", "-u", "http://localhost:3100"], { from: "user" });
    } finally {
      logSpy.mockRestore();
    }

    const output = lines.join("\n");
    expect(output).toContain("agents.md");
    expect(output).toContain("(blob)");
  });
});

describe("task-prompt create", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sends type in the create body when provided", async () => {
    mockFetchWith({ _id: "id-1", type: "agents.md", createdAt: new Date().toISOString() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "create", "-t", "# Guidance", "--type", "agents.md", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    const init = fetchMock().mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ text: "# Guidance", type: "agents.md" });
  });

  it("defaults type to select when not provided", async () => {
    mockFetchWith({ _id: "id-2", createdAt: new Date().toISOString() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "create", "-t", "plain task", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    const init = fetchMock().mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ text: "plain task", type: "select" });
  });
});
