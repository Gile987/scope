// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration test for the report-generator Copilot SDK session.
 *
 * Creates a fixture run archive, then spawns a child Node process to run
 * a real CopilotClient session (vitest's runtime interferes with the SDK's
 * subprocess management, so we isolate the SDK call in a separate process).
 *
 * Requires:
 *   GITHUB_TOKEN — a GitHub PAT with copilot scope
 *
 * Skipped automatically when credentials are unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Credential check — skip entire suite if no token
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const hasCredentials = !!GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_RUN_YAML = `
id: "fixture-run-001"
status: completed
scenario:
  id: "hello-world-express"
  name: "Hello World Express"
agent:
  id: "copilot"
  name: "GitHub Copilot"
turns:
  - iteration: 1
    status: completed
`.trim();

const FIXTURE_HAR = JSON.stringify({
  log: {
    version: "1.2",
    entries: [
      {
        request: { method: "POST", url: "https://api.github.com/copilot/chat", bodySize: 150 },
        response: { status: 200, bodySize: 420 },
        time: 1200,
      },
    ],
  },
});

const FIXTURE_LOGS = [
  JSON.stringify({ timestamp: "2025-01-15T10:00:00Z", level: "info", message: "Session started", iteration: 1 }),
  JSON.stringify({ timestamp: "2025-01-15T10:00:05Z", level: "info", message: "Agent produced output", iteration: 1 }),
  JSON.stringify({ timestamp: "2025-01-15T10:00:10Z", level: "info", message: "Session completed", iteration: 1 }),
].join("\n");

// ---------------------------------------------------------------------------
// Session config matching production (from report-queue-processor.ts)
// ---------------------------------------------------------------------------

const EXCLUDED_TOOLS = [
  "edit",
  "create",
  "write_file",
  "delete_file",
  "ask_user",
  "powershell",
  "sql",
  "web_search",
  "render_widget",
  "discover_widgets",
  "clear_widget",
  "annotate_diff_line",
  "add_pr_review_comment",
  "rename_session",
  "rename_branch",
  "create_issue",
  "create_pull_request",
];

// ---------------------------------------------------------------------------
// Helper: run SDK session in an isolated child process
// ---------------------------------------------------------------------------

interface SessionResult {
  success: boolean;
  response?: string;
  tools?: string[];
  error?: string;
}

/**
 * Spawn a fully detached child Node process that runs the Copilot SDK session.
 * The SDK requires process isolation from vitest — its internal CLI subprocess
 * management fails when running inside vitest's process tree.
 *
 * Results are communicated via a temp file (file-polling pattern) since the
 * child is fully detached with stdio: "ignore".
 */
async function runSDKSession(opts: {
  archiveDir: string;
  systemPrompt: string;
  userPrompt: string;
  excludedTools: string[];
  timeoutMs?: number;
}): Promise<SessionResult> {
  const sdkPath = require.resolve("@github/copilot-sdk");
  const sdkCjsPath = sdkPath.replace(/dist\/index\.js$/, "dist/cjs/index.js");

  const resultPath = join(tmpdir(), `sdk-result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const scriptPath = join(tmpdir(), `sdk-test-${Date.now()}.cjs`);

  const script = `
    const { CopilotClient, approveAll } = require(${JSON.stringify(sdkCjsPath)});
    const fs = require("fs");

    async function main() {
      const client = new CopilotClient({ githubToken: process.env.GITHUB_TOKEN });
      let fullResponse = "";
      const toolsUsed = [];

      try {
        const session = await client.createSession({
          streaming: true,
          tools: [],
          workingDirectory: ${JSON.stringify(opts.archiveDir)},
          excludedTools: ${JSON.stringify(opts.excludedTools)},
          onPermissionRequest: approveAll,
          hooks: {
            onPreToolUse: async () => ({ permissionDecision: "allow" }),
          },
          systemMessage: { mode: "replace", content: ${JSON.stringify(opts.systemPrompt)} },
        });

        session.on((event) => {
          if (event.type === "assistant.message_delta") {
            fullResponse += event.data.deltaContent;
          }
          if (event.type === "tool.execution_start") {
            toolsUsed.push(event.data.toolName);
          }
        });

        await session.sendAndWait(
          { prompt: ${JSON.stringify(opts.userPrompt)} },
          ${opts.timeoutMs ?? 60_000}
        );

        fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          success: true,
          response: fullResponse,
          tools: [...new Set(toolsUsed)],
        }));
      } catch (e) {
        fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          success: false,
          error: e.message,
          response: fullResponse,
          tools: [...new Set(toolsUsed)],
        }));
      } finally {
        await client.stop();
      }
    }

    main();
  `;

  writeFileSync(scriptPath, script);

  // Pass full environment but remove vitest-specific vars
  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  childEnv.GITHUB_TOKEN = GITHUB_TOKEN!;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.VITEST;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;

  const timeoutMs = (opts.timeoutMs ?? 60_000) + 30_000;

  return new Promise<SessionResult>((resolve) => {
    const child = spawn("node", [scriptPath], {
      env: childEnv,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Poll for the result file (child writes it on completion)
    const pollInterval = 1000;
    const startTime = Date.now();

    const timer = setInterval(() => {
      if (existsSync(resultPath)) {
        clearInterval(timer);
        try { rmSync(scriptPath); } catch { /* ignore */ }
        try {
          const raw = readFileSync(resultPath, "utf-8");
          rmSync(resultPath, { force: true });
          resolve(JSON.parse(raw));
        } catch {
          resolve({ success: false, error: "Failed to read/parse result file" });
        }
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(timer);
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* ignore */ }
        try { rmSync(scriptPath); } catch { /* ignore */ }
        resolve({ success: false, error: `Timeout after ${timeoutMs}ms` });
      }
    }, pollInterval);
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasCredentials)("Report Generator – Copilot SDK integration", () => {
  let archiveDir: string;
  let workDir: string;

  beforeAll(() => {
    // Create a temp working directory
    workDir = join(tmpdir(), `report-integration-test-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    // Build fixture archive contents in a staging directory
    const stagingDir = join(workDir, "staging");
    const runDir = join(stagingDir, "fixture-run-001");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, "run.yaml"), FIXTURE_RUN_YAML);
    writeFileSync(join(runDir, "iteration-1.har"), FIXTURE_HAR);
    writeFileSync(join(runDir, "logs.jsonl"), FIXTURE_LOGS);

    // Create the tar.gz archive
    const archivePath = join(workDir, "archive.tar.gz");
    execSync(`tar -czf "${archivePath}" -C "${stagingDir}" fixture-run-001`, {
      timeout: 10_000,
    });

    // Extract (mimics production extraction logic)
    archiveDir = join(workDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    execSync(`tar -xzf "${archivePath}" -C "${archiveDir}"`, { timeout: 10_000 });

    // Detect effective root (single subdirectory → use it as root)
    const topEntries = readdirSync(archiveDir);
    if (topEntries.length === 1) {
      const singleEntry = join(archiveDir, topEntries[0]);
      if (statSync(singleEntry).isDirectory()) {
        archiveDir = singleEntry;
      }
    }
  });

  afterAll(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it(
    "reads files from workingDirectory and produces a response",
    { timeout: 120_000 },
    async () => {
      const result = await runSDKSession({
        archiveDir,
        excludedTools: EXCLUDED_TOOLS,
        systemPrompt:
          "You are a report generator. Use bash (cat) to read files. Be very brief.",
        userPrompt:
          "Use cat to read run.yaml and tell me the scenario name. Be brief.",
        timeoutMs: 30_000,
      });

      expect(result.success, `SDK session failed: ${result.error}`).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.response!.length).toBeGreaterThan(10);

      // The response should reference content from the fixture
      const lowerResponse = result.response!.toLowerCase();
      expect(
        lowerResponse.includes("hello world express") ||
          lowerResponse.includes("hello-world-express") ||
          lowerResponse.includes("copilot")
      ).toBe(true);
    }
  );

  it(
    "excludedTools hides write tools from the agent",
    { timeout: 120_000 },
    async () => {
      const result = await runSDKSession({
        archiveDir,
        excludedTools: EXCLUDED_TOOLS,
        systemPrompt:
          "You are a test assistant. When asked about your tools, list every tool name you have access to. " +
          "Output ONLY a comma-separated list of tool names, nothing else. Do not use any tools to answer.",
        userPrompt:
          "List all tool names you have access to, as a comma-separated list. Do not call any tools.",
        timeoutMs: 30_000,
      });

      expect(result.success, `SDK session failed: ${result.error}`).toBe(true);
      expect(result.response).toBeDefined();
      const lowerResponse = result.response!.toLowerCase();

      // Should NOT mention excluded write tools
      expect(lowerResponse).not.toContain("write_file");
      expect(lowerResponse).not.toContain("delete_file");

      // Should include read-only tools
      expect(
        lowerResponse.includes("view") ||
          lowerResponse.includes("grep") ||
          lowerResponse.includes("glob") ||
          lowerResponse.includes("bash")
      ).toBe(true);
    }
  );
});
