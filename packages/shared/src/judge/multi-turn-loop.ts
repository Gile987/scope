// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ConversationTurn,
  CriterionResult,
  TokenUsage,
  WorkerProcessor,
  WorkerProcessorOptions,
  LogEvent,
  MULTI_TURN_DEFAULTS,
} from "../types/types.js";
import type { McpServerConfig } from "../types/mcp.js";
import type { SkillConfig } from "../types/skill.js";
import type { ExtensionConfig } from "../types/extension.js";
import { BlobStorage, BlobStorageConfig } from "../storage/blob-storage.js";
import { sanitizeHarFile, extractToolCalls } from "../har/har-parser.js";
import type { ToolCall } from "../har/types.js";
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
  /** Workspace directory to snapshot (must be resolved by caller after setup) */
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
  /** Model to pass to the coding agent */
  model?: string;
  /** Resolved MCP server configurations to pass to the coding agent */
  mcpServerConfigs?: McpServerConfig[];
  /** Resolved skill configurations to inject into the agent prompt */
  skillConfigs?: SkillConfig[];
  /** Resolved VS Code extension configurations for runtime installation */
  extensionConfigs?: ExtensionConfig[];
}

export interface MultiTurnResult {
  turns: ConversationTurn[];
  passed: boolean;
  finalResult: string;
  /** True when the loop exited because of an unrecoverable error (agent crash, snapshot failure, judge failure), not because iterations were exhausted. */
  hadError: boolean;
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
    judgeClient,
    blobStorage,
    requestId,
    log,
    onTurnComplete,
    personaInstructions,
    model,
    mcpServerConfigs,
    skillConfigs,
    extensionConfigs,
    workspacePath,
  } = config;

  const turns: ConversationTurn[] = [];
  let nextPrompt = task;
  const startTime = Date.now();

  await log("info", `Starting multi-turn loop (max ${maxIterations} iterations)`, {
    criteria,
    maxIterations,
    mcpServerCount: mcpServerConfigs?.length ?? 0,
    mcpServers: mcpServerConfigs?.map((s) => s.name) ?? [],
    skillCount: skillConfigs?.length ?? 0,
    skills: skillConfigs?.map((s) => s.name) ?? [],
    extensionCount: extensionConfigs?.length ?? 0,
    extensions: extensionConfigs?.map((e) => e.id) ?? [],
  });

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Create a per-iteration logger that automatically injects the iteration number
    // into every log event's data. This ensures all downstream log calls (including
    // those from inside workers) carry iteration context for the CLI to display.
    const iterLog: typeof log = async (level, message, data) =>
      log(level, message, { ...data, iteration });

    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > MULTI_TURN_DEFAULTS.ITERATION_TIMEOUT_MS) {
      await iterLog("warn", `Multi-turn loop timed out after ${Math.round(elapsed / 1000)}s`, { elapsedMs: elapsed });
      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Timed out after ${iteration - 1} iterations (${Math.round(elapsed / 1000)}s)`,
      };
    }

    const iterationStartedAt = new Date();

    await iterLog("info", `--- Iteration ${iteration}/${maxIterations} ---`, {
      promptLength: nextPrompt.length,
      iterationHeader: true,
    });

    // Step 1: Call the coding agent
    await iterLog("info", "Calling coding agent...");
    let codingResponse: string;
    let turnHarUrl: string | undefined;
    let turnTokenUsage: TokenUsage | undefined;
    let turnAiCallCount: number | undefined;
    let turnToolCalls: ToolCall[] | undefined;
    let turnRawChatUrl: string | undefined;
    let turnRawChatFormat: string | undefined;
    const turnVideoUrls: string[] = [];
    try {
      const workerResult = await processor.processMessage(nextPrompt, iterLog, { model, mcpServerConfigs, skillConfigs, extensionConfigs });
      codingResponse = workerResult.response;
      turnTokenUsage = workerResult.tokenUsage;
      turnAiCallCount = workerResult.aiCallCount;

      // Upload HAR file to blob storage if available (sanitized to strip credentials)
      if (workerResult.harFilePath) {
        try {
          const sanitizedHar = await sanitizeHarFile(workerResult.harFilePath, workerResult.harFilePath);
          const harBlobName = `${requestId}/iteration-${iteration}/devproxy.har`;
          turnHarUrl = await blobStorage.uploadFile(
            workerResult.harFilePath,
            harBlobName,
            "application/json"
          );
          await iterLog("info", "HAR file uploaded", { harUrl: turnHarUrl });

          // Extract tool calls from the sanitized HAR so they are persisted on the turn
          try {
            turnToolCalls = extractToolCalls(sanitizedHar);
            if (turnToolCalls.length > 0) {
              await iterLog("info", `Extracted ${turnToolCalls.length} tool call(s) from HAR`);
            }
          } catch (extractError) {
            const msg = extractError instanceof Error ? extractError.message : String(extractError);
            await iterLog("warn", `Failed to extract tool calls from HAR: ${msg}`);
          }
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload HAR file: ${msg}`);
        }
      }

      // Upload video files to blob storage if available
      if (workerResult.videoFilePaths && workerResult.videoFilePaths.length > 0) {
        try {
          for (let i = 0; i < workerResult.videoFilePaths.length; i++) {
            const videoBlobName = `${requestId}/iteration-${iteration}/video-${i}.webm`;
            const videoUrl = await blobStorage.uploadFile(
              workerResult.videoFilePaths[i],
              videoBlobName,
              "video/webm"
            );
            turnVideoUrls.push(videoUrl);
          }
          await iterLog("info", "Video files uploaded", { videoUrls: turnVideoUrls });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload video files: ${msg}`);
        }
      }

      // Upload raw chat transcript to blob storage if available
      if (workerResult.rawChatFilePath) {
        try {
          const chatBlobName = `${requestId}/iteration-${iteration}/chat-export.json`;
          turnRawChatUrl = await blobStorage.uploadFile(
            workerResult.rawChatFilePath,
            chatBlobName,
            "application/json"
          );
          turnRawChatFormat = workerResult.rawChatFormat;
          await iterLog("info", "Raw chat transcript uploaded", { rawChatUrl: turnRawChatUrl });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload raw chat transcript: ${msg}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await iterLog("error", `Coding agent failed: ${errorMsg}`, { error: errorMsg });

      // Extract HAR file path from the error if the worker attached it
      const errorHarFilePath: string | undefined = (error as any)?.harFilePath;
      let errorHarUrl: string | undefined;
      if (errorHarFilePath) {
        try {
          await sanitizeHarFile(errorHarFilePath, errorHarFilePath);
          const harBlobName = `${requestId}/iteration-${iteration}/devproxy.har`;
          errorHarUrl = await blobStorage.uploadFile(
            errorHarFilePath,
            harBlobName,
            "application/json"
          );
          await iterLog("info", "HAR file uploaded from failed iteration", { harUrl: errorHarUrl });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload HAR file from failed iteration: ${msg}`);
        }
      }

      // Extract aiCallCount from the error if the worker attached it
      const errorAiCallCount: number | undefined = (error as any)?.aiCallCount;

      // Extract video paths from the error if the worker attached them
      const errorVideoPaths: string[] = (error as any)?.videoFilePaths ?? [];
      let errorVideoUrls: string[] = [];
      if (errorVideoPaths.length > 0) {
        try {
          for (let i = 0; i < errorVideoPaths.length; i++) {
            const videoBlobName = `${requestId}/iteration-${iteration}/video-${i}.webm`;
            const videoUrl = await blobStorage.uploadFile(
              errorVideoPaths[i],
              videoBlobName,
              "video/webm"
            );
            errorVideoUrls.push(videoUrl);
          }
          await iterLog("info", "Video files uploaded from failed iteration", { videoUrls: errorVideoUrls });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload video files: ${msg}`);
        }
      }

      // Persist a partial turn so HAR/video URLs are not lost
      const partialTurn: ConversationTurn = {
        iteration,
        codingAgentResponse: `Coding agent failed: ${errorMsg}`,
        judgeFeedback: "",
        snapshotUrl: "",
        passed: false,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(errorHarUrl && { harUrl: errorHarUrl }),
        ...(errorVideoUrls.length > 0 && { videoUrls: errorVideoUrls }),
        ...(errorAiCallCount !== undefined && { aiCallCount: errorAiCallCount }),
      };
      turns.push(partialTurn);
      if (onTurnComplete) {
        await onTurnComplete(partialTurn);
      }

      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Coding agent failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await iterLog("info", "Coding agent completed", {
      responseLength: codingResponse.length,
    });

    // Step 2: Snapshot workspace to blob storage
    await iterLog("info", "Uploading workspace snapshot...");
    let snapshotUrl: string;
    try {
      snapshotUrl = await blobStorage.uploadWorkspaceSnapshot(
        workspacePath,
        requestId,
        iteration
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await iterLog("error", `Snapshot upload failed: ${errorMsg}`, { error: errorMsg });

      // Persist a partial turn so video/HAR URLs are not lost
      const partialTurn: ConversationTurn = {
        iteration,
        codingAgentResponse: codingResponse,
        judgeFeedback: `Snapshot upload failed: ${errorMsg}`,
        snapshotUrl: "",
        passed: false,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(turnHarUrl && { harUrl: turnHarUrl }),
        ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
        ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
        ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
      };
      turns.push(partialTurn);
      if (onTurnComplete) {
        await onTurnComplete(partialTurn);
      }

      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Snapshot upload failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await iterLog("info", "Snapshot uploaded", { snapshotUrl });

    // Step 3: Call the judge
    await iterLog("info", "Calling judge for evaluation...");
    let judgePassed: boolean;
    let judgeFeedback: string;
    let criteriaResults: CriterionResult[] | undefined;
    try {
      const judgeResult = await judgeClient.evaluate({
        snapshotUrl,
        criteria,
        conversationHistory: turns,
        personaInstructions,
        requestId,
      });
      judgePassed = judgeResult.passed;
      judgeFeedback = judgeResult.feedback;
      criteriaResults = judgeResult.criteriaResults;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await iterLog("error", `Judge evaluation failed: ${errorMsg}`, { error: errorMsg });

      // Persist a partial turn so video/snapshot URLs are not lost
      const partialTurn: ConversationTurn = {
        iteration,
        codingAgentResponse: codingResponse,
        judgeFeedback: `Judge evaluation failed: ${errorMsg}`,
        snapshotUrl,
        passed: false,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(turnHarUrl && { harUrl: turnHarUrl }),
        ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
        ...(turnTokenUsage && { tokenUsage: turnTokenUsage }),
        ...(turnAiCallCount !== undefined && { aiCallCount: turnAiCallCount }),
        ...(turnToolCalls && turnToolCalls.length > 0 && { toolCalls: turnToolCalls }),
        ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
        ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
      };
      turns.push(partialTurn);
      if (onTurnComplete) {
        await onTurnComplete(partialTurn);
      }

      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Judge evaluation failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    // Emit DAG summary if criteria results are available
    if (criteriaResults && criteriaResults.length > 0) {
      const passed = criteriaResults.filter(r => r.passed).length;
      const failed = criteriaResults.filter(r => r.evaluated && !r.passed).length;
      const skipped = criteriaResults.filter(r => !r.evaluated).length;
      await iterLog("info", `Criteria DAG: ${passed} passed, ${failed} failed, ${skipped} skipped`, {
        type: "criteria_dag_status",
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
      startedAt: iterationStartedAt,
      durationMs: Date.now() - iterationStartedAt.getTime(),
      criteriaResults,
      ...(turnHarUrl && { harUrl: turnHarUrl }),
      ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
      ...(turnTokenUsage && { tokenUsage: turnTokenUsage }),
      ...(turnAiCallCount !== undefined && { aiCallCount: turnAiCallCount }),
      ...(turnToolCalls && turnToolCalls.length > 0 && { toolCalls: turnToolCalls }),
      ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
      ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
    };
    turns.push(turn);

    // Persist incrementally
    if (onTurnComplete) {
      await onTurnComplete(turn);
    }

    if (judgePassed) {
      await iterLog("info", `Judge PASSED on iteration ${iteration}`, {
        totalIterations: iteration,
        feedback: judgeFeedback,
      });
      return {
        turns,
        passed: true,
        hadError: false,
        finalResult: codingResponse,
      } as MultiTurnResult;
    }

    // Step 5: Use judge feedback as next coding prompt
    await iterLog("info", `Judge feedback (iteration ${iteration}): continuing...`, {
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
    hadError: false,
    finalResult: `Max iterations (${maxIterations}) reached. Last coding response: ${
      turns[turns.length - 1]?.codingAgentResponse?.substring(0, 200) || "none"
    }`,
  };
}
