// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import {
  RequestDocument,
  WorkerProcessor,
  QueueProcessorConfig,
  LogEvent,
  MULTI_TURN_DEFAULTS,
  ConversationTurn,
} from "../types/types.js";
import type { McpServerConfig } from "../types/mcp.js";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import { BlobStorage } from "../storage/blob-storage.js";
import { JudgeClient } from "../judge/judge-client.js";
import { runMultiTurnLoop } from "../judge/multi-turn-loop.js";
import { McpServerClient } from "../mcp/mcp-server-client.js";

/**
 * Queue processor for coding agent workers.
 * Extends BaseQueueProcessor with one-shot and multi-turn processing logic,
 * including judge evaluation loops, workspace snapshots, and visibility timeout extension.
 */
export class CodingAgentQueueProcessor extends BaseQueueProcessor<RequestDocument> {
  private processor: WorkerProcessor;

  constructor(config: QueueProcessorConfig, processor: WorkerProcessor) {
    super(config, processor.workerName);
    this.processor = processor;
  }

  protected async handleRequest(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    // Resolve MCP server slugs to configs via API
    let mcpServerConfigs: McpServerConfig[] | undefined;
    if (requestDoc.mcpServers && requestDoc.mcpServers.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("MCP servers requested but SCOPE_MT_API_URL is not configured");
      }
      const mcpClient = new McpServerClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.mcpServers.length} MCP server(s)`, { mcpServers: requestDoc.mcpServers });
      mcpServerConfigs = await mcpClient.resolveServers(requestDoc.mcpServers);
      await log("info", `Resolved MCP servers: ${mcpServerConfigs.map(s => s.name).join(", ")}`);
    }

    // Determine if this is a multi-turn request (criteria present in scenario)
    const isMultiTurn = requestDoc.scenario.criteria && requestDoc.scenario.criteria.length > 0;

    if (isMultiTurn) {
      await this.processMultiTurn(requestDoc, message, currentPopReceipt, log, mcpServerConfigs);
    } else {
      await this.processOneShot(requestDoc, message, currentPopReceipt, log, mcpServerConfigs);
    }
  }

  /**
   * Fire-and-forget report generation trigger via REST API.
   * Called after a run completes if apiBaseUrl is configured.
   */
  private async triggerReportGeneration(requestId: string): Promise<void> {
    const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
    if (!apiBaseUrl) return;

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (response.ok) {
        console.log(`[${this.workerName}] Triggered report generation for request ${requestId}`);
      } else {
        console.warn(`[${this.workerName}] Failed to trigger report generation: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.warn(`[${this.workerName}] Failed to trigger report generation: ${error}`);
    }
  }

  /**
   * Original one-shot processing (backward compatible).
   */
  private async processOneShot(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    mcpServerConfigs?: McpServerConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;

    // Update status to processing
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "processing", logs: [], updatedAt: new Date() } }
    );

    await log("info", `Starting processing with ${this.processor.workerName}`);

    // Process the task using the worker-specific processor
    const result = await this.processor.processMessage(requestDoc.scenario.task, log, { model: requestDoc.model, mcpServerConfigs });

    await log("info", "Processing completed", { result, final: true });

    // Update request with result
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "completed", result, updatedAt: new Date() } }
    );

    console.log(`[${this.workerName}] Completed request ${requestId}`);

    // Fire-and-forget report generation
    await this.triggerReportGeneration(requestId);

    await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  }

  /**
   * Multi-turn processing with judge loop.
   */
  private async processMultiTurn(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    mcpServerConfigs?: McpServerConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (!judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but multi-turn request received (criteria present)");
    }

    // Update status to iterating
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "iterating", logs: [], turns: [], updatedAt: new Date() } }
    );

    // Extend queue message visibility for long-running multi-turn.
    // updateMessage returns a new pop receipt that must be used for subsequent operations.
    const visibilityTimeout = MULTI_TURN_DEFAULTS.VISIBILITY_TIMEOUT_SECONDS;
    try {
      const updateResponse = await this.queueClient.updateMessage(
        message.messageId,
        currentPopReceipt,
        message.messageText,
        visibilityTimeout
      );
      currentPopReceipt = updateResponse.popReceipt!;
    } catch (error) {
      console.warn(`[${this.workerName}] Failed to extend message visibility: ${error}`);
    }

    await log("info", `Starting multi-turn processing with ${this.processor.workerName}`, {
      criteria: requestDoc.scenario.criteria,
      maxIterations: requestDoc.maxIterations,
    });

    const judgeClient = new JudgeClient(judgeServiceUrl);
    const blobStorage = new BlobStorage({
      storageAccountName: this.config.storageAccountName,
      storageConnectionString: this.config.storageConnectionString,
    });

    const workspacePath = process.env.WORKSPACE_PATH || "/workspace";
    const maxIterations = requestDoc.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS;

    const result = await runMultiTurnLoop({
      processor: this.processor,
      task: requestDoc.scenario.task,
      criteria: requestDoc.scenario.criteria,
      scenarioVersion: requestDoc.scenario.version,
      maxIterations,
      workspacePath,
      judgeClient,
      blobStorage,
      requestId,
      log,
      personaInstructions: requestDoc.personaInstructions,
      model: requestDoc.model,
      mcpServerConfigs,
      onTurnComplete: async (turn: ConversationTurn) => {
        // Persist each turn incrementally to MongoDB
        await this.collection.updateOne(
          { _id: requestId },
          {
            $push: { turns: turn },
            $set: { updatedAt: new Date() },
          }
        );
      },
    });

    const finalStatus = result.passed
      ? "completed"
      : result.turns.length >= maxIterations
        ? "exhausted"
        : "failed";
    await log("info", `Multi-turn processing ${finalStatus}`, {
      passed: result.passed,
      totalIterations: result.turns.length,
      final: true,
    });

    await this.collection.updateOne(
      { _id: requestId },
      {
        $set: {
          status: finalStatus,
          result: result.finalResult,
          updatedAt: new Date(),
          ...(result.passed ? {} : { error: result.finalResult }),
        },
      }
    );

    console.log(
      `[${this.workerName}] Multi-turn ${finalStatus} for request ${requestId} (${result.turns.length} iterations)`
    );

    // Fire-and-forget report generation
    await this.triggerReportGeneration(requestId);

    await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  }
}
