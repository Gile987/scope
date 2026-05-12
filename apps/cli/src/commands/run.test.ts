// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerRunCommands } from "./run.js";

interface MockResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

function makeProgram(): Command {
  const program = new Command();
  registerRunCommands(program);
  return program;
}

function mockFetchWith(body: unknown): void {
  const response: MockResponse = {
    ok: true,
    json: async () => body,
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

async function runListAndCaptureOutput(args: string[] = []): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });

  try {
    const program = makeProgram();
    await program.parseAsync(["run", "list", "-u", "http://localhost:3100", ...args], { from: "user" });
  } finally {
    logSpy.mockRestore();
  }

  return lines.join("\n");
}

describe("run list", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders table output for paginated API response", async () => {
    mockFetchWith({
      data: [
        {
          id: "req-paginated-1",
          workerType: "coder-acp-copilot",
          run: { status: "done", outcome: "succeeded" },
          submissionId: "submission-12345678",
        },
      ],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const output = await runListAndCaptureOutput();
    expect(output).toContain("Found 1 request(s):");
    expect(output).toContain("req-paginated-1");
    expect(output).toContain("coder-acp-copilot");
    expect(output).toContain("done");
    expect(output).not.toContain('"data"');
  });

  it("renders table output for legacy array API response", async () => {
    mockFetchWith([
      {
        id: "req-array-1",
        workerType: "coder-acp-claude-code",
        run: { status: "running", outcome: "finished" },
        submissionId: "submission-abcdef12",
      },
    ]);

    const output = await runListAndCaptureOutput();
    expect(output).toContain("Found 1 request(s):");
    expect(output).toContain("req-array-1");
    expect(output).toContain("coder-acp-claude-code");
    expect(output).toContain("running");
  });

  it("keeps json output machine-readable for paginated API response", async () => {
    mockFetchWith({
      data: [
        {
          id: "req-json-1",
          workerType: "coder-acp-copilot",
          run: { status: "done", outcome: "succeeded" },
          submissionId: "submission-feedbeef",
        },
      ],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const output = await runListAndCaptureOutput(["-o", "json"]);
    expect(output).toContain('"id": "req-json-1"');
    expect(output).toContain('"workerType": "coder-acp-copilot"');
    expect(output).not.toContain("Found 1 request(s):");
  });

  it("keeps tsv output machine-readable for paginated API response", async () => {
    mockFetchWith({
      data: [
        {
          id: "req-tsv-1",
          workerType: "coder-acp-copilot",
          run: { status: "done", outcome: "succeeded" },
          submissionId: "submission-11223344",
        },
      ],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const output = await runListAndCaptureOutput(["-o", "tsv"]);
    expect(output).toContain("req-tsv-1\tcoder-acp-copilot\tdone\tsubmissi");
    expect(output).not.toContain("Found 1 request(s):");
  });

  it("keeps yaml output machine-readable for paginated API response", async () => {
    mockFetchWith({
      data: [
        {
          id: "req-yaml-1",
          workerType: "coder-acp-copilot",
          run: { status: "done", outcome: "succeeded" },
          submissionId: "submission-a1b2c3d4",
        },
      ],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const output = await runListAndCaptureOutput(["-o", "yaml"]);
    expect(output).toContain("- id: req-yaml-1");
    expect(output).toContain("workerType: coder-acp-copilot");
    expect(output).toContain("status: done");
    expect(output).not.toContain("Found 1 request(s):");
  });
});

describe("run retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders attempt number when API returns it as a number (regression: styleText rejects non-strings)", async () => {
    mockFetchWith({
      requestId: "req-retry-1",
      runId: "run-retry-1",
      attemptNumber: 8,
    });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["run", "retry", "-i", "req-retry-1", "-u", "http://localhost:3100"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    const output = lines.join("\n");
    expect(output).toContain("Retry started");
    expect(output).toContain("Attempt:");
    expect(output).toContain("8");
  });
});
