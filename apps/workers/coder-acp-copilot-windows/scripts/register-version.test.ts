// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Check if pwsh is available
function hasPwsh(): boolean {
  try {
    execSync("pwsh -NoProfile -Command exit", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SCRIPT_PATH = join(
  import.meta.dirname,
  "..",
  "register-version.ps1",
);

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function runScript(
  apiUrl: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, "-ApiUrl", apiUrl],
      {
        env: { ...process.env, ...env },
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe.runIf(hasPwsh())("register-version.ps1", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let requests: RecordedRequest[];
  let responseOverrides: Map<string, { status: number; body: string }>;
  let tmpDir: string;

  beforeAll(async () => {
    // Create mock HTTP server
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });

      const override = responseOverrides.get(req.url ?? "");
      if (override) {
        res.writeHead(override.status, { "Content-Type": "application/json" });
        res.end(override.body);
        return;
      }

      // Default: return 200 with empty JSON
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(() => {
    server?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    responseOverrides = new Map();

    // Create temp dir with agent.json fixture
    tmpDir = mkdtempSync(join(tmpdir(), "reg-test-"));
    const agentData = {
      _id: "coder-acp-copilot-windows",
      name: "GitHub Copilot CLI (Windows)",
      description: "Test agent",
      modelProvider: "github-copilot",
      available: true,
    };
    writeFileSync(join(tmpDir, "agent.json"), JSON.stringify(agentData));
  });

  it("registers agent and version with correct payloads", async () => {
    const env = {
      COPILOT_CLI_VERSION: "1.2.3",
      BUILD_TIME: "20260601T120000Z",
      GIT_COMMIT: "abc1234",
    };

    // Copy script to tmpDir so PSScriptRoot resolves agent.json
    const { code, stdout, stderr } = await runScript(
      `http://127.0.0.1:${port}`,
      env,
      tmpDir,
    );

    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    expect(requests.length).toBe(3); // health + agent upsert + version

    // Health check
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("/health");

    // Agent upsert
    const agentReq = requests[1];
    expect(agentReq.method).toBe("POST");
    expect(agentReq.url).toBe("/api/v1/agents");
    expect(agentReq.headers["content-type"]).toContain("application/json");
    const agentBody = JSON.parse(agentReq.body);
    expect(agentBody._id).toBe("coder-acp-copilot-windows");
    expect(agentBody.name).toBe("GitHub Copilot CLI (Windows)");
    expect(agentBody.modelProvider).toBe("github-copilot");

    // Version registration
    const versionReq = requests[2];
    expect(versionReq.method).toBe("POST");
    expect(versionReq.url).toBe("/api/v1/agents/coder-acp-copilot-windows/versions");
    const versionBody = JSON.parse(versionReq.body);
    expect(versionBody.agentVersion).toBe("copilot-1.2.3");
    expect(versionBody.workerVersion).toBe("copilot-1.2.3-20260601T120000Z-abc1234");
    expect(versionBody.components.COPILOT_CLI_VERSION).toBe("1.2.3");
    expect(versionBody.gitCommit).toBe("abc1234");
    expect(versionBody.buildTime).toBe("20260601T120000Z");
    expect(versionBody.queueName).toBe("queue-coder-acp-copilot-windows");
  });

  it("uses 'unknown' fallbacks when env vars are missing", async () => {
    const { code, stdout, stderr } = await runScript(
      `http://127.0.0.1:${port}`,
      { COPILOT_CLI_VERSION: "", BUILD_TIME: "", GIT_COMMIT: "" },
      tmpDir,
    );

    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);

    const versionReq = requests[2];
    const versionBody = JSON.parse(versionReq.body);
    expect(versionBody.agentVersion).toBe("copilot-unknown");
    expect(versionBody.workerVersion).toBe("copilot-unknown-unknown-unknown");
    expect(versionBody.components.COPILOT_CLI_VERSION).toBe("unknown");
  });

  it("exits with non-zero code when version registration fails", async () => {
    responseOverrides.set("/api/v1/agents/coder-acp-copilot-windows/versions", {
      status: 500,
      body: JSON.stringify({ error: "Internal Server Error" }),
    });

    const env = {
      COPILOT_CLI_VERSION: "1.0.0",
      BUILD_TIME: "20260101T000000Z",
      GIT_COMMIT: "deadbeef",
    };

    const { code } = await runScript(`http://127.0.0.1:${port}`, env, tmpDir);
    expect(code).not.toBe(0);
  });

  it("continues when agent upsert fails but version registration succeeds", async () => {
    responseOverrides.set("/api/v1/agents", {
      status: 500,
      body: JSON.stringify({ error: "DB error" }),
    });

    const env = {
      COPILOT_CLI_VERSION: "1.0.0",
      BUILD_TIME: "20260101T000000Z",
      GIT_COMMIT: "deadbeef",
    };

    const { code, stdout, stderr } = await runScript(`http://127.0.0.1:${port}`, env, tmpDir);

    // Script should still succeed (agent upsert failure is a warning)
    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    // Version registration still attempted
    expect(requests.some((r) => r.url?.includes("/versions"))).toBe(true);
  });
});
