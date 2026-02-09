// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ConversationTurn,
  WorkerProcessor,
  LogEvent,
  MULTI_TURN_DEFAULTS,
} from "./types.js";
import { BlobStorage, BlobStorageConfig } from "./blob-storage.js";
import { JudgeClient } from "./judge-client.js";

export interface MultiTurnConfig {
  /** The coding worker processor (unchanged interface, called per iteration) */
  processor: WorkerProcessor;
  /** The task to perform */
  task: string;
  /** Judge evaluation criteria */
  criteria: string[];
  /** Maximum number of iterations before giving up */
  maxIterations: number;
  /** Path to the workspace directory to snapshot */
  workspacePath: string;
  /** Judge REST API client */
  judgeClient: JudgeClient;
  /** Blob storage client for workspace snapshots */
  blobStorage: BlobStorage;
  /** Request ID (for snapshot naming) */
  requestId: string;
  /** Logging function */
  log: (
    level: LogEvent["level"],
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>;
  /** Called after each iteration to persist the turn to MongoDB */
  onTurnComplete?: (turn: ConversationTurn) => Promise<void>;
  /** Persona instructions for the judge (resolved prose from traits) */
  personaInstructions?: string;
}

export interface MultiTurnResult {
  turns: ConversationTurn[];
  passed: boolean;
  finalResult: string;
}

/**
 * Runs the multi-turn coding + judge loop.
 *
 * For each iteration:
 *   1. Calls the coding agent with the current prompt
 *   2. Snapshots the workspace to blob storage
 *   3. Calls the judge REST API to evaluate the snapshot against criteria
 *   4. If judge says passed → done
 *   5. Otherwise, uses judge feedback as the next prompt
 *
 * The WorkerProcessor interface is unchanged — each iteration is a single processMessage call.
 */
export async function runMultiTurnLoop(
  config: MultiTurnConfig
): Promise<MultiTurnResult> {
  const {
    processor,
    task,
    criteria,
    maxIterations,
    workspacePath,
    judgeClient,
    blobStorage,
    requestId,
    log,
    onTurnComplete,
    personaInstructions,
  } = config;

  const turns: ConversationTurn[] = [];
  let nextPrompt = task;
  const startTime = Date.now();

  await log("info", `Starting multi-turn loop (max ${maxIterations} iterations)`, {
    criteria,
    maxIterations,
  });

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > MULTI_TURN_DEFAULTS.ITERATION_TIMEOUT_MS) {
      await log("warn", `Multi-turn loop timed out after ${Math.round(elapsed / 1000)}s`);
      return {
        turns,
        passed: false,
        finalResult: `Timed out after ${iteration - 1} iterations (${Math.round(elapsed / 1000)}s)`,
      };
    }

    await log("info", `--- Iteration ${iteration}/${maxIterations} ---`, {
      iteration,
      promptLength: nextPrompt.length,
    });

    // Step 1: Call the coding agent
    await log("info", "Calling coding agent...");
    let codingResponse: string;
    try {
      codingResponse = await processor.processMessage(nextPrompt, log);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log("error", `Coding agent failed on iteration ${iteration}: ${errorMsg}`);
      return {
        turns,
        passed: false,
        finalResult: `Coding agent failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await log("info", "Coding agent completed", {
      responseLength: codingResponse.length,
    });

    // Step 2: Snapshot workspace to blob storage
    await log("info", "Uploading workspace snapshot...");
    let snapshotUrl: string;
    try {
      snapshotUrl = await blobStorage.uploadWorkspaceSnapshot(
        workspacePath,
        requestId,
        iteration
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log("error", `Snapshot upload failed: ${errorMsg}`);
      return {
        turns,
        passed: false,
        finalResult: `Snapshot upload failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await log("info", "Snapshot uploaded", { snapshotUrl });

    // Step 3: Call the judge
    await log("info", "Calling judge for evaluation...");
    let judgePassed: boolean;
    let judgeFeedback: string;
    try {
      const judgeResult = await judgeClient.evaluate({
        snapshotUrl,
        criteria,
        conversationHistory: turns,
        personaInstructions,
      });
      judgePassed = judgeResult.passed;
      judgeFeedback = judgeResult.feedback;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log("error", `Judge evaluation failed: ${errorMsg}`);
      return {
        turns,
        passed: false,
        finalResult: `Judge evaluation failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    // Step 4: Record the turn
    const turn: ConversationTurn = {
      iteration,
      codingAgentResponse: codingResponse,
      judgeFeedback,
      snapshotUrl,
      passed: judgePassed,
      timestamp: new Date(),
    };
    turns.push(turn);

    // Persist incrementally
    if (onTurnComplete) {
      await onTurnComplete(turn);
    }

    if (judgePassed) {
      await log("info", `Judge PASSED on iteration ${iteration}`, {
        iteration,
        totalIterations: iteration,
        feedback: judgeFeedback,
      });
      return {
        turns,
        passed: true,
        finalResult: codingResponse,
      };
    }

    // Step 5: Use judge feedback as next coding prompt
    await log("info", `Judge feedback (iteration ${iteration}): continuing...`, {
      iteration,
      feedbackLength: judgeFeedback.length,
      feedback: judgeFeedback.substring(0, 500),
    });
    nextPrompt = judgeFeedback;
  }

  // Max iterations exhausted
  await log("warn", `Max iterations (${maxIterations}) reached without passing`, {
    totalIterations: maxIterations,
  });
  return {
    turns,
    passed: false,
    finalResult: `Max iterations (${maxIterations}) reached. Last coding response: ${
      turns[turns.length - 1]?.codingAgentResponse?.substring(0, 200) || "none"
    }`,
  };
}
