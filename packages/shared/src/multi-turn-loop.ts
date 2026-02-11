// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ConversationTurn,
  CriterionResult,
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
  /** Scenario version (v1 = inline prompts, v2 = criteria IDs) */
  scenarioVersion?: 'v1' | 'v2';
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
    scenarioVersion,
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
      await log("warn", `Multi-turn loop timed out after ${Math.round(elapsed / 1000)}s`, { iteration, elapsedMs: elapsed });
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
    await log("info", "Calling coding agent...", { iteration });
    let codingResponse: string;
    try {
      codingResponse = await processor.processMessage(nextPrompt, log);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log("error", `Coding agent failed on iteration ${iteration}: ${errorMsg}`, { iteration, error: errorMsg });
      return {
        turns,
        passed: false,
        finalResult: `Coding agent failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await log("info", "Coding agent completed", {
      iteration,
      responseLength: codingResponse.length,
    });

    // Step 2: Snapshot workspace to blob storage
    await log("info", "Uploading workspace snapshot...", { iteration });
    let snapshotUrl: string;
    try {
      snapshotUrl = await blobStorage.uploadWorkspaceSnapshot(
        workspacePath,
        requestId,
        iteration
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log("error", `Snapshot upload failed: ${errorMsg}`, { iteration, error: errorMsg });
      return {
        turns,
        passed: false,
        finalResult: `Snapshot upload failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await log("info", "Snapshot uploaded", { iteration, snapshotUrl });

    // Step 3: Call the judge
    await log("info", "Calling judge for evaluation...", { iteration });
    let judgePassed: boolean;
    let judgeFeedback: string;
    let criteriaResults: CriterionResult[] | undefined;
    try {
      const judgeResult = await judgeClient.evaluate({
        snapshotUrl,
        criteria,
        conversationHistory: turns,
        personaInstructions,
        scenarioVersion,
        requestId,
      });
      judgePassed = judgeResult.passed;
      judgeFeedback = judgeResult.feedback;
      criteriaResults = judgeResult.criteriaResults;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log("error", `Judge evaluation failed: ${errorMsg}`, { iteration, error: errorMsg });
      return {
        turns,
        passed: false,
        finalResult: `Judge evaluation failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    // Emit DAG summary if criteria results are available
    if (criteriaResults && criteriaResults.length > 0) {
      const passed = criteriaResults.filter(r => r.passed).length;
      const failed = criteriaResults.filter(r => r.evaluated && !r.passed).length;
      const skipped = criteriaResults.filter(r => !r.evaluated).length;
      await log("info", `Criteria DAG: ${passed} passed, ${failed} failed, ${skipped} skipped`, {
        type: "criteria_dag_status",
        iteration,
        results: criteriaResults.map(r => ({
          criterionId: r.criterionId,
          passed: r.passed,
          evaluated: r.evaluated,
          feedback: r.feedback,
        })),
        allPassed: judgePassed,
      });
    }

    // Step 4: Record the turn
    const turn: ConversationTurn = {
      iteration,
      codingAgentResponse: codingResponse,
      judgeFeedback,
      snapshotUrl,
      passed: judgePassed,
      timestamp: new Date(),
      criteriaResults,
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
    iteration: maxIterations,
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
