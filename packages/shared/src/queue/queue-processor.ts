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
import type { SkillConfig } from "../types/skill.js";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import { BlobStorage } from "../storage/blob-storage.js";
import { sanitizeHarFile } from "../har/har-parser.js";
import { JudgeClient } from "../judge/judge-client.js";
import { runMultiTurnLoop } from "../judge/multi-turn-loop.js";
import { McpServerClient } from "../mcp/mcp-server-client.js";
import { SkillClient } from "../skills/skill-client.js";
import { extractSkillsToWorkspace } from "../skills/skill-extractor.js";

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

    // Resolve skill revision refs to configs via API
    let skillConfigs: SkillConfig[] | undefined;
    if (requestDoc.skillRevisions && requestDoc.skillRevisions.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("Skill revisions requested but SCOPE_MT_API_URL is not configured");
      }
      const skillClient = new SkillClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.skillRevisions.length} skill revision(s)`, { skillRevisions: requestDoc.skillRevisions });
      skillConfigs = await skillClient.resolveSkills(requestDoc.skillRevisions);
      await log("info", `Resolved skills: ${skillConfigs.map(s => s.name).join(", ")}`);

      // Extract skill archives to workspace filesystem for agent discovery
      const workspacePath = process.env.WORKSPACE_PATH || "/workspace";
      // Derive agent type from workerType for agent-specific skill directories
      const agentType = requestDoc.workerType.includes("claude") ? "claude-code"
        : requestDoc.workerType.includes("copilot") ? "copilot"
        : undefined;
      const installedPaths = await extractSkillsToWorkspace({
        refs: requestDoc.skillRevisions,
        skillConfigs,
        skillClient,
        workspacePath,
        agentType,
        log: async (msg) => { await log("info", msg); },
      });
      await log("info", `Installed ${installedPaths.length} skill path(s) to workspace`, { installedPaths });
    }

    // Determine if this is a multi-turn request (criteria present in scenario)
    const isMultiTurn = requestDoc.scenario.criteria && requestDoc.scenario.criteria.length > 0;

    if (isMultiTurn) {
      await this.processMultiTurn(requestDoc, message, currentPopReceipt, log, mcpServerConfigs, skillConfigs);
    } else {
      await this.processOneShot(requestDoc, message, currentPopReceipt, log, mcpServerConfigs, skillConfigs);
    }
  }

  /**
   * Fire-and-forget report generation trigger via REST API.
   * Calls the trigger endpoint which evaluates all report templates' triggers
   * and creates a report for each matching template.
   */
  private async triggerReportGeneration(requestId: string): Promise<void> {
    const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
    if (!apiBaseUrl) return;

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/reports/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (response.ok) {
        const result = await response.json() as { triggered: number };
        console.log(`[${this.workerName}] Triggered report generation for request ${requestId}: ${result.triggered} report(s) created`);
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
    mcpServerConfigs?: McpServerConfig[],
    skillConfigs?: SkillConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;

    // Update status to processing (preserve logs from handleRequest — MCP/skill resolution)
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "processing", updatedAt: new Date(), ...(this.processor.getAgentVersion ? { agentVersion: this.processor.getAgentVersion() } : {}) } }
    );

    await log("info", `Starting processing with ${this.processor.workerName}`);

    // Lifecycle: call setup() before processMessage so workers can acquire expensive resources
    if (this.processor.setup) {
      const setupResult = await this.processor.setup(log, { model: requestDoc.model, mcpServerConfigs, skillConfigs });

      // Upload setup-phase videos (e.g. TOTP login recording) to a dedicated blob path
      if (setupResult?.videoFilePaths && setupResult.videoFilePaths.length > 0) {
        try {
          const blobStorage = new BlobStorage({
            storageAccountName: this.config.storageAccountName,
            storageConnectionString: this.config.storageConnectionString,
          });
          const setupVideoUrls: string[] = [];
          for (let i = 0; i < setupResult.videoFilePaths.length; i++) {
            const videoBlobName = `${requestId}/setup/video-${i}.webm`;
            const videoUrl = await blobStorage.uploadFile(
              setupResult.videoFilePaths[i],
              videoBlobName,
              "video/webm"
            );
            setupVideoUrls.push(videoUrl);
          }
          await log("info", "Setup video files uploaded", { videoCount: setupResult.videoFilePaths.length });
          if (setupVideoUrls.length > 0) {
            await this.collection.updateOne(
              { _id: requestId },
              { $set: { setupVideoUrls, updatedAt: new Date() } }
            );
          }
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await log("warn", `Failed to upload setup video files: ${msg}`);
        }
      }
    }

    let workerResult;
    try {
      // Process the task using the worker-specific processor
      workerResult = await this.processor.processMessage(requestDoc.scenario.task, log, { model: requestDoc.model, mcpServerConfigs, skillConfigs });
    } finally {
      // Lifecycle: always call teardown() if setup() exists, even on error
      if (this.processor.teardown) {
        await this.processor.teardown(log);
      }
    }

    await log("info", "Processing completed", { responseLength: workerResult.response.length, final: true });

    // Upload HAR file to blob storage if available (sanitized to strip credentials)
    let harUrl: string | undefined;
    if (workerResult.harFilePath) {
      try {
        await sanitizeHarFile(workerResult.harFilePath, workerResult.harFilePath);
        const blobStorage = new BlobStorage({
          storageAccountName: this.config.storageAccountName,
          storageConnectionString: this.config.storageConnectionString,
        });
        harUrl = await blobStorage.uploadFile(
          workerResult.harFilePath,
          `${requestId}/devproxy.har`,
          "application/json"
        );
        await log("info", "HAR file uploaded to blob storage", { harUrl });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `Failed to upload HAR file: ${msg}`);
      }
    }

    // Upload video files to blob storage if available
    let videoUrls: string[] | undefined;
    if (workerResult.videoFilePaths && workerResult.videoFilePaths.length > 0) {
      try {
        const blobStorage = new BlobStorage({
          storageAccountName: this.config.storageAccountName,
          storageConnectionString: this.config.storageConnectionString,
        });
        videoUrls = [];
        for (let i = 0; i < workerResult.videoFilePaths.length; i++) {
          const videoUrl = await blobStorage.uploadFile(
            workerResult.videoFilePaths[i],
            `${requestId}/video-${i}.webm`,
            "video/webm"
          );
          videoUrls.push(videoUrl);
        }
        await log("info", "Video files uploaded to blob storage", { videoUrls });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `Failed to upload video files: ${msg}`);
      }
    }

    // Update request with result and HAR URL
    await this.collection.updateOne(
      { _id: requestId },
      {
        $set: {
          status: "completed",
          result: workerResult.response,
          ...(harUrl && { harUrl }),
          ...(videoUrls && videoUrls.length > 0 && { videoUrls }),
          updatedAt: new Date(),
        },
      }
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
    mcpServerConfigs?: McpServerConfig[],
    skillConfigs?: SkillConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (!judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but multi-turn request received (criteria present)");
    }

    // Update status to iterating (preserve logs from handleRequest — MCP/skill resolution)
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "iterating", turns: [], updatedAt: new Date(), ...(this.processor.getAgentVersion ? { agentVersion: this.processor.getAgentVersion() } : {}) } }
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
      skillConfigs,
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
      onSetupVideosUploaded: async (setupVideoUrls: string[]) => {
        await this.collection.updateOne(
          { _id: requestId },
          { $set: { setupVideoUrls, updatedAt: new Date() } }
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
