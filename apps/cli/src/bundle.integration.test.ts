// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { existsSync, copyFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const BUNDLE_PATH = resolve(import.meta.dirname, "../dist/scope.mjs");

if (!existsSync(BUNDLE_PATH)) {
  throw new Error(
    `Bundle not found at ${BUNDLE_PATH}. Run "pnpm build:bundle" first.`
  );
}

/** Canned API responses for the mock server */
const MOCK_RESPONSES: Record<string, unknown> = {
  "/api/v1/requests": {
    data: [
      {
        id: "req-test-001",
        workerType: "coder-acp-copilot",
        run: { status: "done", outcome: "succeeded" },
        submissionId: "sub-abc123",
      },
    ],
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  },
  "/api/v1/criteria": [
    {
      id: "has_button",
      prompt: "Page has a button element",
      dependsOn: [],
    },
  ],
};

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const response = MOCK_RESPONSES[url.pathname];
    if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  server?.close();
});

async function runScope(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("node", [BUNDLE_PATH, ...args], {
    env: {
      ...process.env,
      SCOPE_NO_UPDATE_CHECK: "1",
      SCOPE_API_URL: `http://127.0.0.1:${port}`,
    },
    timeout: 10000,
  });
  return { stdout, stderr };
}

describe("Bundle integration tests", () => {
  it("--version prints the version", async () => {
    const { stdout } = await runScope("--version");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help shows usage information", async () => {
    const { stdout } = await runScope("--help");
    expect(stdout).toContain("scope");
    expect(stdout).toContain("Scope — The AI Agentic Experience Evaluation Platform");
    expect(stdout).not.toContain("MS Scope");
    expect(stdout).toContain("run");
    expect(stdout).toContain("criteria");
  });

  it("run list fetches from mock API and formats output", async () => {
    const { stdout } = await runScope("run", "list", "-u", `http://127.0.0.1:${port}`);
    expect(stdout).toContain("req-test-001");
    expect(stdout).toContain("coder-acp-copilot");
    expect(stdout).toContain("done");
  });

  it("criteria list fetches from mock API", async () => {
    const { stdout } = await runScope("criteria", "list", "-u", `http://127.0.0.1:${port}`);
    expect(stdout).toContain("has_button");
  });

  it("run list --output json returns valid JSON", async () => {
    const { stdout } = await runScope("run", "list", "-u", `http://127.0.0.1:${port}`, "-o", "json");
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe("req-test-001");
  });

  it("works when installed as 'scope' (no .mjs extension)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    const scopeBin = join(tempDir, "scope");
    try {
      copyFileSync(BUNDLE_PATH, scopeBin);
      chmodSync(scopeBin, 0o755);
      const { stdout } = await execFileAsync("node", [scopeBin, "--version"], {
        env: { ...process.env, SCOPE_NO_UPDATE_CHECK: "1" },
        timeout: 10000,
      });
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
