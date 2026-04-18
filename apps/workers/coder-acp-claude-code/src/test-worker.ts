#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Test harness that runs inside the Docker container.
 *
 * Exercises runACPSession() with the real claude-agent-acp binary and outputs a
 * JSON result to stdout so the host-side vitest test can assert on it.
 *
 * Usage: npx tsx src/test-worker.ts
 *
 * Env vars:
 *   ANTHROPIC_API_KEY — Anthropic API key (required)
 *   TEST_PROMPT       — First prompt to send (required)
 *   TEST_PROMPT_2     — Optional second prompt (tests session reuse)
 */
import { runACPSession } from "./acp-client.js";
import { createFreshWorkspace } from "shared";

interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
}

interface TestResult {
  /** Results for each prompt (1 or 2 entries) */
  prompts: PromptResult[];
  /** Which step the worker reached before it failed/completed */
  lastStep?: string;
  logs?: string[];
}

const collectedLogs: string[] = [];

function emit(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23);
  const line = `[${ts}] ${msg}`;
  collectedLogs.push(line);
  process.stderr.write(line + "\n");
}

async function main(): Promise<void> {
  emit("test-worker starting");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY env var is required");
  }

  const prompts = [process.env.TEST_PROMPT].filter(Boolean) as string[];
  if (process.env.TEST_PROMPT_2) prompts.push(process.env.TEST_PROMPT_2);

  if (prompts.length === 0) {
    throw new Error("TEST_PROMPT env var is required");
  }

  const result: TestResult = { prompts: [] };
  const workspacePath = createFreshWorkspace();
  emit(`Created workspace: ${workspacePath}`);

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const label = i === 0 ? "first" : "second";
    emit(`${label} prompt: ${prompt}`);

    const promptResult: PromptResult = { success: false };
    try {
      emit(`calling runACPSession (${label})...`);
      const acpResult = await runACPSession(prompt, {
        command: "claude-agent-acp",
        args: [],
        env: {
          ANTHROPIC_API_KEY: apiKey,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          NODE_EXTRA_CA_CERTS: "",
        },
        cwd: workspacePath,
        onLog: (msg) => emit(`[acp] ${msg}`),
      });
      emit(`runACPSession (${label}) completed — stopReason=${acpResult.stopReason}`);
      promptResult.success = true;
      promptResult.response = acpResult.response;
      promptResult.stopReason = acpResult.stopReason;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emit(`runACPSession (${label}) failed: ${msg}`);
      promptResult.error = msg;
      result.prompts.push(promptResult);
      break;
    }
    result.prompts.push(promptResult);
  }

  // Determine last step from logs
  const stepKeywords = [
    "Starting ACP agent",
    "Connected to agent",
    "Authenticated",
    "Created session",
    "Set session mode",
    "Sending prompt",
    "Agent completed",
  ];
  for (const kw of stepKeywords.reverse()) {
    if (collectedLogs.some((l) => l.includes(kw))) {
      result.lastStep = kw;
      break;
    }
  }

  result.logs = collectedLogs;

  const allSucceeded = result.prompts.every((p) => p.success);
  emit(`last step reached: ${result.lastStep ?? "(none)"}`);
  emit(`prompts: ${result.prompts.length}, all succeeded: ${allSucceeded}`);
  console.log("TEST_RESULT:" + JSON.stringify(result));

  process.exit(allSucceeded ? 0 : 1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  emit(`fatal error: ${msg}`);
  console.log(
    "TEST_RESULT:" +
      JSON.stringify({
        prompts: [{ success: false, error: msg }],
        logs: collectedLogs,
      }),
  );
  process.exit(1);
});
