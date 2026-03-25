// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration tests for coder-acp-copilot worker.
 *
 * Builds the Docker image (dev stage) and runs test-worker.ts inside the
 * container, which exercises runACPSession() end-to-end with a real
 * GitHub token and the copilot CLI binary.
 *
 * Credentials are passed as env vars:
 *   GITHUB_TOKEN — GitHub PAT with copilot scope
 *
 * Requires Docker. Skipped automatically when Docker or credentials are unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Docker from "dockerode";
import { loadVersions, isDockerAvailable, imageExists, buildImage } from "./docker-test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const IMAGE_TAG = "coder-acp-copilot-integration-test";

// ---------------------------------------------------------------------------
// Env-var configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const hasCredentials = !!GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
}

interface TestResult {
  prompts: PromptResult[];
  lastStep?: string;
  logs?: string[];
}

/**
 * Run test-worker.ts inside the Docker image and return parsed results.
 */
async function runTestWorker(
  docker: Docker,
  env: string[],
): Promise<{ result: TestResult; exitCode: number }> {
  const container = await docker.createContainer({
    Image: IMAGE_TAG,
    Cmd: ["npx", "tsx", "src/test-worker.ts"],
    Env: env,
    WorkingDir: "/app/apps/workers/coder-acp-copilot",
    HostConfig: {},
  });

  // Attach to stream container output in real-time
  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "");
    if (text.trim()) {
      process.stderr.write(`[container] ${text}`);
      if (!text.endsWith("\n")) process.stderr.write("\n");
    }
  });

  await container.start();
  const { StatusCode } = await container.wait();

  // Grab full logs for parsing TEST_RESULT
  const logBuffer = await container.logs({ stdout: true, stderr: true });
  await container.remove().catch(() => {});

  const raw = logBuffer.toString("utf-8");
  const stdout = raw.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "");

  const match = stdout.match(/TEST_RESULT:(\{.*\})/);
  if (!match) {
    throw new Error(`No TEST_RESULT found in container output:\n${stdout.substring(0, 2000)}`);
  }
  const result: TestResult = JSON.parse(match[1]);

  return { result, exitCode: StatusCode };
}

/** Write to stderr so Vitest never swallows it */
function log(msg: string): void {
  process.stderr.write(`[integration] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("coder-acp-copilot integration", async () => {
  const dockerAvailable = await isDockerAvailable();
  const canRun = hasCredentials && dockerAvailable;

  if (!canRun) {
    const reasons: string[] = [];
    if (!hasCredentials) reasons.push("missing GITHUB_TOKEN");
    if (!dockerAvailable) reasons.push("Docker unavailable");
    log(`Skipping: ${reasons.join("; ")}`);
  }

  const docker = new Docker();

  beforeAll(async () => {
    if (!canRun) return;

    const versions = loadVersions();

    if (await imageExists(docker, IMAGE_TAG)) {
      log("Docker image already exists (pre-built by CI), skipping build");
    } else {
      log("Building Docker image (dev stage)...");
      await buildImage(docker, {
        context: REPO_ROOT,
        tag: IMAGE_TAG,
        dockerfile: "apps/workers/coder-acp-copilot/Dockerfile",
        target: "dev",
        buildargs: versions,
      });
      log("Docker build complete");
    }
  }, 600_000); // 10 min for Docker build

  afterAll(async () => {
    if (!canRun) return;
    try {
      await docker.getImage(IMAGE_TAG).remove({ force: true });
    } catch {
      // ignore
    }
  }, 60_000);

  // -----------------------------------------------------------------------
  // Main e2e test: real auth + coding prompt + session reuse
  // -----------------------------------------------------------------------

  it.skipIf(!canRun)(
    "processMessage completes a coding prompt with real GitHub auth",
    { timeout: 300_000 },
    async () => {
      log("Starting e2e test: copilot CLI with real credentials");

      const { result, exitCode } = await runTestWorker(docker, [
        `GITHUB_TOKEN=${GITHUB_TOKEN}`,
        "TEST_PROMPT=Generate a Hello World REST API in Python using Flask.",
        "TEST_PROMPT_2=Add a /health endpoint to the Flask app that returns 200 OK.",
      ]);

      log(`exit=${exitCode} lastStep=${result.lastStep}`);
      log(`prompts completed: ${result.prompts.length}`);

      // --- First prompt assertions ---
      const first = result.prompts[0];
      expect(first, "First prompt result missing").toBeTruthy();
      expect(first.error, `First prompt failed: ${first?.error}`).toBeUndefined();
      expect(first.success).toBe(true);
      expect(first.response).toBeTruthy();

      // The copilot CLI writes code to files via tool calls and returns a
      // human-readable summary, so we only verify the response is non-trivial.
      expect(
        first.response!.length > 10,
        `Expected non-trivial response, got: ${first.response!.substring(0, 200)}`,
      ).toBe(true);

      // --- Second prompt assertions (session reuse) ---
      const second = result.prompts[1];
      expect(second, "Second prompt result missing — session reuse not tested").toBeTruthy();
      expect(second.error, `Second prompt failed: ${second?.error}`).toBeUndefined();
      expect(second.success).toBe(true);
      expect(second.response).toBeTruthy();

      expect(
        second.response!.length > 10,
        `Expected non-trivial response, got: ${second.response!.substring(0, 200)}`,
      ).toBe(true);
    },
  );
});
