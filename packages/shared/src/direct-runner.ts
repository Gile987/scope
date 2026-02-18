// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { WorkerProcessor, LogEvent, MULTI_TURN_DEFAULTS } from "./types.js";
import { BlobStorage } from "./blob-storage.js";
import { JudgeClient } from "./judge-client.js";
import { runMultiTurnLoop, MultiTurnResult } from "./multi-turn-loop.js";
import { randomUUID } from "crypto";

/**
 * Stdin request schema for the direct runner.
 * Passed as JSON through stdin when bypassing the queue.
 */
export interface DirectRunRequest {
  task: string;
  criteria?: string[];
  scenarioVersion?: "v1" | "v2";
  maxIterations?: number;
  judgeUrl?: string;
  storageAccountName?: string;
  storageConnectionString?: string;
  personaInstructions?: string;
  workspacePath?: string;
  requestId?: string;
}

/**
 * Stdout response schema from the direct runner.
 * Written as JSON to stdout when the run completes.
 */
export interface DirectRunResponse {
  success: boolean;
  result?: string;
  error?: string;
  turns?: MultiTurnResult["turns"];
  passed?: boolean;
  logs: LogEvent[];
}

/**
 * Reads all of stdin as a string.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/**
 * Runs a worker processor directly, bypassing the queue.
 *
 * Reads a JSON request from stdin, calls the processor, and writes
 * a JSON response to stdout. Logs are emitted to stderr for real-time
 * visibility and also collected into the response.
 *
 * Supports both one-shot (no criteria) and multi-turn (criteria + judge loop).
 */
export async function runDirect(processor: WorkerProcessor): Promise<void> {
  const collectedLogs: LogEvent[] = [];

  const log = async (
    level: LogEvent["level"],
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> => {
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      source: processor.workerName,
      message,
      data,
    };
    collectedLogs.push(event);
    // Emit to stderr for real-time visibility
    process.stderr.write(JSON.stringify(event) + "\n");
  };

  const writeResponse = (response: DirectRunResponse): void => {
    process.stdout.write(JSON.stringify(response) + "\n");
  };

  try {
    // Read and parse stdin
    const rawInput = await readStdin();
    let request: DirectRunRequest;
    try {
      request = JSON.parse(rawInput);
    } catch {
      writeResponse({
        success: false,
        error: `Invalid JSON input: ${rawInput.substring(0, 200)}`,
        logs: collectedLogs,
      });
      process.exit(1);
      return;
    }

    if (!request.task) {
      writeResponse({
        success: false,
        error: 'Missing required field: "task"',
        logs: collectedLogs,
      });
      process.exit(1);
      return;
    }

    const workspacePath = request.workspacePath || "/workspace";
    const requestId = request.requestId || randomUUID();

    await log("info", `Direct run started for ${processor.workerName}`, {
      requestId,
      hasCriteria: !!(request.criteria && request.criteria.length > 0),
      workspacePath,
    });

    // Determine mode: one-shot vs multi-turn
    if (request.criteria && request.criteria.length > 0) {
      // Multi-turn mode
      const judgeUrl = request.judgeUrl || process.env.JUDGE_SERVICE_URL || "http://localhost:3200";
      const storageAccountName = request.storageAccountName || process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
      const storageConnectionString =
        request.storageConnectionString ||
        process.env.STORAGE_CONNECTION_STRING ||
        process.env.AZURE_STORAGE_CONNECTION_STRING;

      const judgeClient = new JudgeClient(judgeUrl);
      const blobStorage = new BlobStorage({
        storageAccountName,
        storageConnectionString,
      });

      await log("info", "Running in multi-turn mode", {
        criteriaCount: request.criteria.length,
        maxIterations: request.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS,
        judgeUrl,
      });

      const multiTurnResult = await runMultiTurnLoop({
        processor,
        task: request.task,
        criteria: request.criteria,
        scenarioVersion: request.scenarioVersion,
        maxIterations: request.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS,
        workspacePath,
        judgeClient,
        blobStorage,
        requestId,
        log,
        personaInstructions: request.personaInstructions,
      });

      writeResponse({
        success: multiTurnResult.passed,
        result: multiTurnResult.finalResult,
        turns: multiTurnResult.turns,
        passed: multiTurnResult.passed,
        logs: collectedLogs,
      });
    } else {
      // One-shot mode
      await log("info", "Running in one-shot mode");

      const result = await processor.processMessage(request.task, log);

      await log("info", "One-shot processing complete", {
        resultLength: result.length,
      });

      writeResponse({
        success: true,
        result,
        passed: true,
        logs: collectedLogs,
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log("error", `Direct run failed: ${errorMsg}`);
    writeResponse({
      success: false,
      error: errorMsg,
      logs: collectedLogs,
    });
    process.exit(1);
  }
}
