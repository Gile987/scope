// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import os from "node:os";
import {
  RequestDocument,
  WorkerProcessor,
  QueueProcessorConfig,
  LogEvent,
  MULTI_TURN_DEFAULTS,
  ConversationTurn,
  OsInfo,
} from "../types/types.js";
import type { McpServerConfig } from "../types/mcp.js";
import type { SkillConfig } from "../types/skill.js";
import type { ExtensionConfig } from "../types/extension.js";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import { BlobStorage } from "../storage/blob-storage.js";
import { withRetry } from "../utils/retry.js";
import { sanitizeHarFile } from "../har/har-parser.js";
import { JudgeClient } from "../judge/judge-client.js";
import { runMultiTurnLoop } from "../judge/multi-turn-loop.js";
import { McpServerClient } from "../mcp/mcp-server-client.js";
import { McpSecretClient } from "../mcp/mcp-secret-client.js";
import { SkillClient } from "../skills/skill-client.js";
import { ExtensionClient } from "../extensions/extension-client.js";
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

  /** Build workerVersion and OS fields for stamping on request documents.
   *  agentVersion is set at submission time by the API — the worker only adds workerVersion.
   *  OS info is always captured regardless of agentVersion availability. */
  private getVersionFields(): { os: OsInfo; workerVersion?: string } {
    const fields: { os: OsInfo; workerVersion?: string } = {
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
    };
    const agentVersion = this.processor.getAgentVersion?.();
    if (agentVersion) {
      const gitCommit = process.env.GIT_COMMIT || "unknown";
      const buildTime = process.env.BUILD_TIME || "unknown";
      fields.workerVersion = `${agentVersion}-${buildTime}-${gitCommit}`;
    }
    return fields;
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

      // Hydrate configs with real plaintext secrets from Token Manager
      const tokenManagerUrl = (this.config as QueueProcessorConfig).tokenManagerUrl;
      if (tokenManagerUrl) {
        const secretClient = new McpSecretClient(tokenManagerUrl);
        const hydratedNames: string[] = [];
        mcpServerConfigs = await Promise.all(
          mcpServerConfigs.map(async (config) => {
            try {
              const resolved = await secretClient.resolveSecrets(config.slug);
              if ('env' in resolved && resolved.env && Object.keys(resolved.env).length > 0) {
                hydratedNames.push(config.name);
                return { ...config, env: resolved.env };
              }
              if ('headers' in resolved && resolved.headers && resolved.headers.length > 0) {
                hydratedNames.push(config.name);
                return { ...config, headers: resolved.headers };
              }
              return config;
            } catch (err) {
              await log("warn", `Failed to hydrate secrets for MCP server '${config.name}' (${config.slug})`, {
                error: err instanceof Error ? err.message : String(err),
              });
              return config;
            }
          })
        );
        if (hydratedNames.length > 0) {
          await log("info", `Hydrated secrets for MCP servers: ${hydratedNames.join(", ")}`);
        }
      } else {
        await log("warn", "TOKEN_MANAGER_URL not configured — MCP server secrets will not be resolved");
      }
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
    }

    // Resolve extension specs (id or id@version) to configs via API
    let extensionConfigs: ExtensionConfig[] | undefined;
    if (requestDoc.extensions && requestDoc.extensions.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("Extensions requested but SCOPE_MT_API_URL is not configured");
      }
      const extensionClient = new ExtensionClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.extensions.length} extension(s)`, { extensions: requestDoc.extensions });
      extensionConfigs = await extensionClient.resolveExtensions(requestDoc.extensions);
      await log("info", `Resolved extensions: ${extensionConfigs.map(e => e.version ? `${e.id}@${e.version}` : e.id).join(", ")}`);
    }

    await this.processMultiTurn(requestDoc, message, currentPopReceipt, log, mcpServerConfigs, skillConfigs, extensionConfigs);
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
   * Extract skill archives to the workspace filesystem so agents can discover them.
   * Must be called after setup() so that processor.workspacePath points to the
   * freshly-created temp directory rather than the stale default.
   */
  private async extractSkills(
    requestDoc: RequestDocument,
    skillConfigs: SkillConfig[],
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (!requestDoc.skillRevisions || requestDoc.skillRevisions.length === 0) return;

    const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
    if (!apiBaseUrl) return;

    const workspacePath = this.processor.workspacePath || process.env.WORKSPACE_PATH || "/workspace";
    const agentType = requestDoc.workerType.includes("claude") ? "claude-code"
      : requestDoc.workerType.includes("copilot") ? "copilot"
      : undefined;
    const skillClient = new SkillClient(apiBaseUrl);
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

  /**
   * Multi-turn processing with judge loop.
   */
  private async processMultiTurn(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    mcpServerConfigs?: McpServerConfig[],
    skillConfigs?: SkillConfig[],
    extensionConfigs?: ExtensionConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;
    const hasCriteria = requestDoc.scenario.criteria && requestDoc.scenario.criteria.length > 0;
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (hasCriteria && !judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but request has criteria to evaluate");
    }

    // Update status to iterating (preserve logs from handleRequest — MCP/skill resolution)
    const versionFields = this.getVersionFields();
    await withRetry(() => this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "processing", turns: [], updatedAt: new Date(), ...versionFields } }
    ));

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

    // Only create JudgeClient when criteria exist and judge will actually be called
    const judgeClient = hasCriteria && judgeServiceUrl ? new JudgeClient(judgeServiceUrl) : undefined;
    const blobStorage = new BlobStorage({
      storageAccountName: this.config.storageAccountName,
      storageConnectionString: this.config.storageConnectionString,
    });

    const maxIterations = requestDoc.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS;

    // Setup: create workspace, extract skills, upload setup videos
    if (this.processor.setup) {
      const setupResult = await this.processor.setup(log, { model: requestDoc.model, mcpServerConfigs, skillConfigs, extensionConfigs });

      if (setupResult?.videoFilePaths && setupResult.videoFilePaths.length > 0) {
        try {
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
            await withRetry(() => this.collection.updateOne(
              { _id: requestId },
              { $set: { setupVideoUrls, updatedAt: new Date() } }
            ));
          }
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await log("warn", `Failed to upload setup video files: ${msg}`);
        }
      }
    }

    // Extract skills to the workspace (after setup so workspacePath is resolved)
    if (skillConfigs) {
      await this.extractSkills(requestDoc, skillConfigs, log);
    }

    // Resolve workspace path after setup
    const workspacePath = this.processor.workspacePath || process.env.WORKSPACE_PATH || "/workspace";

    let result;
    try {
      result = await runMultiTurnLoop({
        processor: this.processor,
        task: requestDoc.scenario.task,
        criteria: requestDoc.scenario.criteria,
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
        extensionConfigs,
        onTurnComplete: async (turn: ConversationTurn) => {
          // Persist each turn incrementally to MongoDB (retry on CosmosDB 429)
          await withRetry(() => this.collection.updateOne(
            { _id: requestId },
            {
              $push: { turns: turn },
              $set: { updatedAt: new Date() },
            }
          ));
        },
      });
    } finally {
      // Lifecycle: always call teardown() if setup() exists, even on error
      if (this.processor.teardown) {
        await this.processor.teardown(log);
      }
    }

    const finalStatus = "done";
    const finalOutcome = result.passed
      ? "succeeded"
      : result.hadError
        ? "failed"
        : result.turns.length >= maxIterations
          ? "finished"
          : "failed";
    await log("info", `Multi-turn processing ${finalOutcome}`, {
      passed: result.passed,
      totalIterations: result.turns.length,
      final: true,
    });

    const totalAiCallCount = result.turns.reduce((sum, t) => sum + (t.aiCallCount ?? 0), 0);

    await withRetry(() => this.collection.updateOne(
      { _id: requestId },
      {
        $set: {
          status: finalStatus,
          outcome: finalOutcome,
          result: result.finalResult,
          updatedAt: new Date(),
          ...(totalAiCallCount > 0 && { aiCallCount: totalAiCallCount }),
          ...(result.passed ? {} : { error: result.finalResult }),
        },
      }
    ));

    console.log(
      `[${this.workerName}] Multi-turn ${finalStatus} for request ${requestId} (${result.turns.length} iterations)`
    );

    // Fire-and-forget report generation
    await this.triggerReportGeneration(requestId);

    await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  }
}
