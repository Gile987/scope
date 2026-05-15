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
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";
import { HEARTBEAT_VISIBILITY_SECONDS } from "./visibility-heartbeat.js";
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
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    // Run-retry-attempts: verify the message targets the request's CURRENT run.
    // If a retry has since started a new attempt, this message is stale and
    // must be discarded so we don't clobber the new run's state.
    const messageRunId = typeof payload?.runId === "string" ? payload.runId : undefined;
    const currentRunId = requestDoc.run?._id;
    if (messageRunId && currentRunId && messageRunId !== currentRunId) {
      console.log(
        `[${this.workerName}] Stale message for ${requestDoc._id}: runId=${messageRunId} but current=${currentRunId} \u2014 discarding`,
      );
      await log("warn", `Stale queue message discarded (runId mismatch)`, {
        messageRunId,
        currentRunId,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    // If the request was paused while sitting in the queue, discard the
    // message. The scheduler will re-enqueue when the user resumes.
    if (requestDoc.run?.status === "paused") {
      console.log(
        `[${this.workerName}] Request ${requestDoc._id} is paused — discarding queue message`,
      );
      await log("info", `Request paused — discarding queue message`);
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    // Redelivery handling: if the run is already in "processing" state, the
    // message was redelivered by Azure Storage Queue while the original
    // worker was busy. There are two cases we need to disambiguate using
    // the per-run liveness heartbeat (run.lastHeartbeatAt + run.worker):
    //
    //   1. Original worker is alive (fresh heartbeat) \u2014 a spurious
    //      redelivery (transient queue-extension miss, throttling, etc.).
    //      Drop the duplicate message and leave the run untouched so the
    //      original worker keeps making progress.
    //
    //   2. Original worker is dead (stale heartbeat, or no heartbeat field
    //      at all on legacy in-flight runs) \u2014 mark the run failed atomically
    //      so the user can retry. The user opts into a clean restart via
    //      the explicit POST /requests/:id/retry endpoint, which properly
    //      demotes the failed run to history.
    //
    // The atomic findOneAndUpdate is gated on the staleness condition so we
    // don't race a worker that has just resumed beating between our read
    // and our write.
    if (requestDoc.run?.status === "processing") {
      const staleThresholdMs =
        Number(process.env.SCOPE_RUN_HEARTBEAT_STALE_MS) ||
        2 * HEARTBEAT_VISIBILITY_SECONDS * 1000;
      const lastHeartbeatAt = requestDoc.run.lastHeartbeatAt instanceof Date
        ? requestDoc.run.lastHeartbeatAt
        : requestDoc.run.lastHeartbeatAt
          ? new Date(requestDoc.run.lastHeartbeatAt as any)
          : undefined;
      const ageMs = lastHeartbeatAt ? Date.now() - lastHeartbeatAt.getTime() : Infinity;
      const isStale = !lastHeartbeatAt || ageMs > staleThresholdMs;
      const workerInfo = requestDoc.run.worker;
      const workerDesc = workerInfo
        ? `instance=${workerInfo.instanceId}${workerInfo.podName ? ` pod=${workerInfo.podName}` : ""}`
        : "unknown worker";

      if (!isStale) {
        // Original worker is still beating — drop the duplicate, keep run state.
        console.warn(
          `[${this.workerName}] Duplicate message for ${requestDoc._id} (runId=${requestDoc.run._id}) — original worker still alive (${workerDesc}, last beat ${Math.round(ageMs / 1000)}s ago); dropping`,
        );
        await log(
          "warn",
          `Duplicate queue message dropped — original worker still heart-beating (${workerDesc}, last beat ${Math.round(ageMs / 1000)}s ago)`,
          { runId: requestDoc.run._id },
        );
        await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
        return;
      }

      const staleCutoff = new Date(Date.now() - staleThresholdMs);
      const errorMsg = `Worker presumed dead (${workerDesc}, last heartbeat ${lastHeartbeatAt ? `${Math.round(ageMs / 1000)}s ago` : "never"}, threshold ${Math.round(staleThresholdMs / 1000)}s); queue message redelivered while run was in 'processing' state`;
      const claim = await withRetry(() => this.collection.findOneAndUpdate(
        {
          _id: requestDoc._id,
          "run._id": requestDoc.run!._id,
          "run.status": "processing",
          // Re-check staleness atomically: either the field is missing, or
          // it's older than the cutoff. Prevents racing a worker that just
          // resumed beating between our read above and this write.
          $or: [
            { "run.lastHeartbeatAt": { $exists: false } },
            { "run.lastHeartbeatAt": { $lt: staleCutoff } },
          ],
        } as any,
        {
          $set: {
            "run.status": "done",
            "run.outcome": "failed",
            "run.error": errorMsg,
            "run.finishedAt": new Date(),
            "run.updatedAt": new Date(),
            updatedAt: new Date(),
          },
        } as any,
      ));
      if (claim) {
        console.warn(
          `[${this.workerName}] Stale-heartbeat redelivery for ${requestDoc._id} (runId=${requestDoc.run._id}, ${workerDesc}) — marked run as failed`,
        );
        await log(
          "error",
          `Run marked failed: ${errorMsg}. Use the retry endpoint to start a new attempt.`,
          { final: true, runId: requestDoc.run._id },
        );
      } else {
        // Either the original worker resumed beating between our read and
        // write, or a concurrent retry already demoted this run, or the
        // original just finished. Nothing to do — drop the duplicate.
        console.log(
          `[${this.workerName}] Redelivery for ${requestDoc._id} but run state / heartbeat changed concurrently — discarding`,
        );
      }
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
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

    await this.processMultiTurn(requestDoc, message, heartbeat, log, mcpServerConfigs, skillConfigs, extensionConfigs);
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
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    mcpServerConfigs?: McpServerConfig[],
    skillConfigs?: SkillConfig[],
    extensionConfigs?: ExtensionConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;
    // Resolve the runId for blob paths. New requests always have run._id;
    // legacy/pre-migration docs may not, in which case we fall back to the
    // requestId so the layout matches the legacy `{requestId}/...` scheme.
    const runId = requestDoc.run?._id ?? requestId;
    const hasCriteria = requestDoc.scenario.criteria && requestDoc.scenario.criteria.length > 0;
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (hasCriteria && !judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but request has criteria to evaluate");
    }

    // Update status to iterating (preserve logs from handleRequest — MCP/skill resolution).
    // Write to run.* (run-retry-attempts) plus a top-level updatedAt for index freshness.
    // Stamp run.worker (instance identity) and an initial run.lastHeartbeatAt
    // atomically so the redelivery handler in another worker can immediately
    // see this pickup and won't treat the run as orphaned.
    const versionFields = this.getVersionFields();
    const now = new Date();
    await withRetry(() => this.collection.updateOne(
      { _id: requestId },
      {
        $set: {
          "run.status": "processing",
          "run.startedAt": now,
          "run.updatedAt": now,
          "run.lastHeartbeatAt": now,
          "run.worker": {
            instanceId: this.instanceId,
            ...(this.podName ? { podName: this.podName } : {}),
          },
          "run.turns": [],
          "run.workerVersion": versionFields.workerVersion,
          "run.os": versionFields.os,
          updatedAt: now,
        },
      }
    ));

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
            const videoBlobName = `${requestId}/runs/${runId}/setup/video-${i}.webm`;
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
              { $set: { "run.setupVideoUrls": setupVideoUrls, "run.updatedAt": new Date(), updatedAt: new Date() } }
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
        runId,
        log,
        personaInstructions: requestDoc.personaInstructions,
        model: requestDoc.model,
        mcpServerConfigs,
        skillConfigs,
        extensionConfigs,
        onTurnComplete: async (turn: ConversationTurn) => {
          // Persist each turn incrementally to MongoDB (retry on CosmosDB 429).
          // Push to run.turns (run-retry-attempts shape).
          await withRetry(() => this.collection.updateOne(
            { _id: requestId },
            {
              $push: { "run.turns": turn },
              $set: { "run.updatedAt": new Date(), updatedAt: new Date() },
            } as any
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
          "run.status": finalStatus,
          "run.outcome": finalOutcome,
          "run.result": result.finalResult,
          "run.finishedAt": new Date(),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
          ...(totalAiCallCount > 0 && { "run.aiCallCount": totalAiCallCount }),
          ...(result.passed ? {} : { "run.error": result.finalResult }),
        },
      }
    ));

    console.log(
      `[${this.workerName}] Multi-turn ${finalStatus} for request ${requestId} (${result.turns.length} iterations)`
    );

    // Fire-and-forget report generation
    await this.triggerReportGeneration(requestId);

    // Stop the heartbeat before deleting so the pop receipt is stable —
    // a tick landing between read and delete would invalidate it. The
    // base class also calls stop() in its finally block (it's idempotent).
    const finalPopReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, finalPopReceipt);
  }
}
