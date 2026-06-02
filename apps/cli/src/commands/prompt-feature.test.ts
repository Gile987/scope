// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerPromptFeatureCommands } from "./prompt-feature.js";

function makeProgram(): Command {
  const program = new Command();
  registerPromptFeatureCommands(program);
  return program;
}

function mockFetchWith(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("prompt-feature list", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes --type as a query param", async () => {
    mockFetchWith([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["prompt-feature", "list", "--type", "agents.md", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    const url = fetchMock().mock.calls[0][0] as string;
    expect(url).toContain("type=agents.md");
  });

  it("renders a Type column defaulting to 'task'", async () => {
    mockFetchWith([{ id: "feat-1", prompt: "detect something" }]);
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      lines.push(p.map(String).join(" "));
    });

    try {
      const program = makeProgram();
      await program.parseAsync(["prompt-feature", "list", "-u", "http://localhost:3100"], { from: "user" });
    } finally {
      logSpy.mockRestore();
    }

    expect(lines.join("\n")).toContain("task");
  });
});

describe("prompt-feature create", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sends type in the create body when provided", async () => {
    mockFetchWith({ id: "feat-new" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["prompt-feature", "create", "--id", "my_feat", "--prompt", "detect x", "--type", "agents.md", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    const init = fetchMock().mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ id: "my_feat", prompt: "detect x", type: "agents.md" });
  });

  it("omits type when not provided (backward compatible)", async () => {
    mockFetchWith({ id: "feat-new-2" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["prompt-feature", "create", "--id", "my_feat2", "--prompt", "detect y", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    const init = fetchMock().mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ id: "my_feat2", prompt: "detect y" });
  });
});
