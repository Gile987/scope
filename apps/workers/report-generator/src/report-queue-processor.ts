// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import { CopilotClient, SessionEvent, approveAll } from "@github/copilot-sdk";
import { mkdirSync, rmSync, existsSync, readFileSync, createWriteStream, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { execSync } from "child_process";
import {
  BaseQueueProcessor,
  BaseQueueProcessorConfig,
  LogEvent,
  ReportDocument,
  ReportTemplateDocument,
  Reporter,
  TokenManagerClient,
  type VisibilityHeartbeat,
} from "shared";
import { createReportTools } from "./tools.js";
import { REPORT_SYSTEM_PROMPT, withRetry } from "shared";

export interface ReportQueueProcessorConfig extends BaseQueueProcessorConfig {
  /** The LLM model to use for report generation, e.g. "gpt-4.1" */
  reportModel: string;
  /** Base URL of the scope-mt API, e.g. "http://localhost:3001" */
  apiBaseUrl: string;
  /** Timeout in ms for the Copilot SDK session (default: 5 min) */
  sessionTimeoutMs?: number;
}

/**
 * Queue processor for LLM-generated run reports.
 *
 * Extends BaseQueueProcessor<ReportDocument>. Picks up report jobs from the
 * queue, fetches run data via REST API tools, invokes the Copilot SDK to
 * generate a markdown report, and persists the result to MongoDB.
 */
export class ReportQueueProcessor extends BaseQueueProcessor<ReportDocument> {
  private reportConfig: ReportQueueProcessorConfig;
  private tokenClient: TokenManagerClient;

  constructor(config: ReportQueueProcessorConfig) {
    super(config, "report-generator");
    this.reportConfig = config;
    this.tokenClient = new TokenManagerClient();
  }

  /**
   * Report queue messages use `reportId` (not `requestId`).
   */
  protected override extractDocumentId(payload: Record<string, unknown>): string {
    return payload.reportId as string;
  }

  protected override async handleRequest(
    doc: ReportDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const reportId = doc._id;
    const requestId = doc.requestId;

    await log("info", `Starting report generation for run ${requestId}`);

    // --- Prepare working directory ---
    const workDir = join(tmpdir(), `report-${reportId}`);
    mkdirSync(workDir, { recursive: true });

    try {
      // --- Resolve report template (cheap check before expensive download) ---
      if (!doc.templateId) {
        throw new Error(`Report ${reportId} has no templateId — reports without a template are no longer supported`);
      }

      const template = await this.fetchReportTemplate(doc.templateId);
      if (!template) {
        throw new Error(`Report template '${doc.templateId}' not found for report ${reportId}`);
      }

      await log("info", `Using report template '${template.id}' (${template.name})`);

      // --- Download and extract run archive to disk ---
      await log("info", `Downloading archive for run ${requestId}`);
      const archiveDir = await this.downloadAndExtractArchive(requestId, workDir, log);
      await log("info", `Archive extracted to ${archiveDir}`);

      // --- Create Copilot SDK tools (insight API tools only) ---
      const tools = createReportTools({
        apiBaseUrl: this.reportConfig.apiBaseUrl,
        reportId,
      });

      await log("info", "Initialized tools, starting Copilot SDK session");

      // Resolve model: template override → global config fallback
      const resolvedModel = template.model ?? this.reportConfig.reportModel;

      // --- Build reporter identity ---
      const reporter: Reporter = {
        id: "report-generator",
        name: "Report Generator",
        gitHash: process.env.GIT_COMMIT || "unknown",
        model: resolvedModel,
        agentId: "copilot-sdk",
        agentVersion: this.getAgentVersion(),
      };

      // Update status to "generating" and set reporter
      await withRetry(() => this.collection.updateOne(
        { _id: reportId } as any,
        {
          $set: {
            status: "generating",
            reporter,
            updatedAt: new Date(),
          },
        } as any
      ));

      await log("info", `Reporter: ${reporter.agentId}@${reporter.agentVersion}, model: ${reporter.model}`);

      const resolvedUserPrompt = template.userPrompt.replace(/\{\{requestId\}\}|\{requestId\}/g, requestId);

      // Resolve system prompt
      let resolvedSystemPrompt: string;
      if (template.systemPrompt) {
        if (template.systemPrompt.mode === "override") {
          resolvedSystemPrompt = template.systemPrompt.content;
        } else {
          // mode === "append"
          resolvedSystemPrompt = REPORT_SYSTEM_PROMPT + "\n\n" + template.systemPrompt.content;
        }
      } else {
        resolvedSystemPrompt = REPORT_SYSTEM_PROMPT;
      }

      // --- Run Copilot SDK session ---
      const resolvedTimeoutMs = template.timeoutMs ?? this.reportConfig.sessionTimeoutMs ?? 5 * 60 * 1000;
      const content = await this.runCopilotSession(
        tools,
        resolvedUserPrompt,
        resolvedSystemPrompt,
        resolvedModel,
        resolvedTimeoutMs,
        archiveDir,
        log
      );

      // --- Persist report content ---
      await withRetry(() => this.collection.updateOne(
        { _id: reportId } as any,
        {
          $set: {
            status: "completed",
            content,
            updatedAt: new Date(),
          },
        } as any
      ));

      await log("info", `Report completed (${content.length} chars)`, { final: true });
    } finally {
      // Clean up working directory
      if (existsSync(workDir)) {
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[report-generator] Failed to clean up work dir: ${err}`);
        }
      }
    }

    // Stop the heartbeat before deleting so the pop receipt is stable.
    // The base class also calls stop() in its finally block (idempotent).
    const finalPopReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, finalPopReceipt);
  }

  /** Char-count interval for emitting delta progress logs */
  private static readonly DELTA_LOG_INTERVAL = 2000;

  /**
   * Run a Copilot SDK session with the report tools and system prompt.
   * Streams response deltas and logs progress.  Forwards key
   * {@link SessionEvent} types to `log()` so the portal can display
   * real-time progress on the Logs tab.
   */
  private async runCopilotSession(
    tools: ReturnType<typeof createReportTools>,
    userPrompt: string,
    systemPrompt: string,
    model: string,
    timeoutMs: number,
    workingDirectory: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    await log("info", "Acquired Copilot SDK token");

    const client = new CopilotClient({ githubToken });
    let fullResponse = "";
    let lastLoggedCharCount = 0;

    // Track in-flight tool names so we can pair start/complete events
    const toolNames = new Map<string, string>();

    try {
      const session = await client.createSession({
        model,
        streaming: true,
        tools,
        workingDirectory,
        excludedTools: [
          // Write tools -- agent shouldn't see these in a read-only analysis session
          "edit",
          "create",
          "write_file",
          "delete_file",
          // Interactive tools -- no user available
          "ask_user",
          // Platform tools -- not relevant for report generation
          "powershell",
          "sql",
          "web_search",
          "render_widget",
          "discover_widgets",
          "clear_widget",
          "annotate_diff_line",
          "add_pr_review_comment",
          "rename_session",
          "rename_branch",
          "create_issue",
          "create_pull_request",
        ],
        onPermissionRequest: approveAll,
        hooks: {
          onPreToolUse: async () => {
            return { permissionDecision: "allow" as const };
          },
        },
        systemMessage: { mode: "replace", content: systemPrompt },
      });

      // Forward session events to structured log
      session.on((event: SessionEvent) => {
        switch (event.type) {
          // --- Session lifecycle ---
          case "session.start":
            void log("info", "Copilot session started", {
              sessionId: event.data.sessionId,
              model: event.data.selectedModel,
            });
            break;

          case "session.error":
            void log("error", `Session error: ${event.data.message}`, {
              errorType: event.data.errorType,
            });
            break;

          case "session.info":
            void log("info", `Session: ${event.data.message}`);
            break;

          // --- Assistant turns ---
          case "assistant.turn_start":
            void log("info", "Assistant turn started", {
              turnId: event.data.turnId,
            });
            break;

          case "assistant.turn_end":
            void log("info", "Assistant turn ended", {
              turnId: event.data.turnId,
            });
            break;

          // --- Tool calls ---
          case "tool.execution_start":
            toolNames.set(event.data.toolCallId, event.data.toolName);
            void log("info", `Tool call: ${event.data.toolName}`, {
              toolCallId: event.data.toolCallId,
              arguments: event.data.arguments as Record<string, unknown> | undefined,
            });
            break;

          case "tool.execution_complete": {
            const name = toolNames.get(event.data.toolCallId) ?? "unknown";
            toolNames.delete(event.data.toolCallId);
            const status = event.data.success ? "success" : "failed";
            const extra: Record<string, unknown> = { toolCallId: event.data.toolCallId };
            if (event.data.error) {
              extra.error = event.data.error.message;
            }
            void log("info", `Tool result: ${name} (${status})`, extra);
            break;
          }

          // --- Streamed response ---
          case "assistant.message_delta":
            fullResponse += event.data.deltaContent;

            // Emit periodic progress logs (throttled by char count)
            if (fullResponse.length - lastLoggedCharCount >= ReportQueueProcessor.DELTA_LOG_INTERVAL) {
              lastLoggedCharCount = fullResponse.length;
              void log("info", `Generating report… (${fullResponse.length} chars so far)`);
            }
            break;
        }
      });

      const timeout = timeoutMs;

      await log("info", `Sending prompt to Copilot SDK, awaiting response (timeout: ${Math.round(timeout / 1000)}s)...`);
      await session.sendAndWait({ prompt: userPrompt }, timeout);
      await client.stop();

      if (!fullResponse.trim()) {
        throw new Error("Copilot SDK returned an empty response");
      }

      return fullResponse;
    } catch (error) {
      try { await client.stop(); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Read the @github/copilot-sdk version from its package.json.
   */
  private getAgentVersion(): string {
    try {
      const copilotPkgPath = require.resolve("@github/copilot-sdk/package.json");
      const pkg = JSON.parse(readFileSync(copilotPkgPath, "utf-8"));
      return pkg.version || "unknown";
    } catch {
      // ESM fallback: try relative path from node_modules
      try {
        const fallbackPath = join(
          process.cwd(),
          "node_modules",
          "@github",
          "copilot-sdk",
          "package.json"
        );
        const pkg = JSON.parse(readFileSync(fallbackPath, "utf-8"));
        return pkg.version || "unknown";
      } catch {
        return "unknown";
      }
    }
  }

  /**
   * Fetch a report template from the API by its slug ID.
   * Returns null if the template is not found or on error.
   */
  private async fetchReportTemplate(templateId: string): Promise<ReportTemplateDocument | null> {
    try {
      const response = await fetch(
        `${this.reportConfig.apiBaseUrl}/api/v1/report-templates/${encodeURIComponent(templateId)}`
      );
      if (!response.ok) {
        console.warn(`[report-generator] Failed to fetch template '${templateId}': ${response.status}`);
        return null;
      }
      return await response.json() as ReportTemplateDocument;
    } catch (error) {
      console.warn(`[report-generator] Error fetching template '${templateId}': ${error}`);
      return null;
    }
  }

  /**
   * Download the run archive from the API and extract it to disk.
   * Streams the tar.gz response directly to a file, then extracts it.
   * Also extracts nested iteration snapshot tar.gz files into a snapshots/ subdirectory.
   *
   * @returns Path to the extracted archive root directory.
   */
  private async downloadAndExtractArchive(
    requestId: string,
    workDir: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    const archivePath = join(workDir, "archive.tar.gz");
    const archiveDir = join(workDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    // Stream-download the archive to disk
    const response = await fetch(
      `${this.reportConfig.apiBaseUrl}/api/v1/requests/${requestId}/archive`
    );
    if (!response.ok) {
      throw new Error(
        `Failed to download archive for run ${requestId}: ${response.status} ${response.statusText}`
      );
    }
    if (!response.body) {
      throw new Error("Archive response has no body");
    }

    // Stream response body to file (avoids buffering in memory)
    const fileStream = createWriteStream(archivePath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    await log("info", "Archive downloaded, extracting...");

    // Extract the tar.gz archive
    execSync(`tar -xzf "${archivePath}" -C "${archiveDir}"`, { timeout: 120_000 });

    // The archive contains files under a {requestId}/ subdirectory
    // Detect the actual root (may be nested one level)
    let effectiveRoot = archiveDir;
    const topEntries = readdirSync(archiveDir);
    if (topEntries.length === 1) {
      const singleEntry = join(archiveDir, topEntries[0]);
      if (existsSync(singleEntry) && statSync(singleEntry).isDirectory()) {
        effectiveRoot = singleEntry;
      }
    }

    // Extract nested iteration snapshot tar.gz files into a snapshots/ subdirectory
    const snapshotsDir = join(effectiveRoot, "snapshots");
    const entries = readdirSync(effectiveRoot);
    const snapshotArchives = entries.filter(
      (f) => f.match(/^iteration-\d+\.tar\.gz$/)
    );

    if (snapshotArchives.length > 0) {
      mkdirSync(snapshotsDir, { recursive: true });
      for (const snapshotFile of snapshotArchives) {
        const match = snapshotFile.match(/^iteration-(\d+)\.tar\.gz$/);
        if (!match) continue;
        const iterNum = match[1];
        const iterDir = join(snapshotsDir, `iteration-${iterNum}`);
        mkdirSync(iterDir, { recursive: true });
        try {
          execSync(`tar -xzf "${join(effectiveRoot, snapshotFile)}" -C "${iterDir}"`, {
            timeout: 60_000,
          });
        } catch (err) {
          await log("warn", `Failed to extract snapshot ${snapshotFile}: ${err}`);
        }
      }
      await log("info", `Extracted ${snapshotArchives.length} iteration snapshot(s)`);
    }

    // Clean up the compressed archive file to save disk space
    try {
      execSync(`rm -f "${archivePath}"`);
    } catch { /* best effort */ }

    return effectiveRoot;
  }
}
