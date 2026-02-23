// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  BaseQueueProcessor,
  BaseQueueProcessorConfig,
  LogEvent,
  ReportDocument,
  Reporter,
  TokenManagerClient,
} from "shared";
import { createReportTools } from "./tools.js";
import { REPORT_SYSTEM_PROMPT } from "./prompt.js";

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
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const reportId = doc._id;
    const requestId = doc.requestId;

    await log("info", `Starting report generation for run ${requestId}`);

    // --- Build reporter identity ---
    const reporter: Reporter = {
      id: "report-generator",
      name: "Report Generator",
      gitHash: process.env.GIT_COMMIT || "unknown",
      model: this.reportConfig.reportModel,
      agentId: "copilot-sdk",
      agentVersion: this.getAgentVersion(),
    };

    // Update status to "generating" and set reporter
    await this.collection.updateOne(
      { _id: reportId } as any,
      {
        $set: {
          status: "generating",
          reporter,
          updatedAt: new Date(),
        },
      } as any
    );

    await log("info", `Reporter: ${reporter.agentId}@${reporter.agentVersion}, model: ${reporter.model}`);

    // --- Prepare snapshots temp directory ---
    const snapshotsDir = join(tmpdir(), `report-${reportId}`);
    mkdirSync(snapshotsDir, { recursive: true });

    try {
      // --- Create Copilot SDK tools ---
      const tools = createReportTools(
        this.reportConfig.apiBaseUrl,
        requestId,
        snapshotsDir,
        reportId
      );

      await log("info", "Initialized tools, starting Copilot SDK session");

      // --- Run Copilot SDK session ---
      const content = await this.runCopilotSession(
        tools,
        requestId,
        log
      );

      // --- Persist report content ---
      await this.collection.updateOne(
        { _id: reportId } as any,
        {
          $set: {
            status: "completed",
            content,
            updatedAt: new Date(),
          },
        } as any
      );

      await log("info", `Report completed (${content.length} chars)`, { final: true });
    } finally {
      // Clean up extracted snapshot files
      if (existsSync(snapshotsDir)) {
        try {
          rmSync(snapshotsDir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[report-generator] Failed to clean up snapshots dir: ${err}`);
        }
      }
    }

    // Delete the queue message on success
    await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  }

  /**
   * Run a Copilot SDK session with the report tools and system prompt.
   * Streams response deltas and logs progress.
   */
  private async runCopilotSession(
    tools: ReturnType<typeof createReportTools>,
    requestId: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ githubToken });
    let fullResponse = "";

    try {
      const session = await client.createSession({
        model: this.reportConfig.reportModel,
        streaming: true,
        tools,
        systemMessage: { mode: "replace", content: REPORT_SYSTEM_PROMPT },
      });

      // Accumulate streamed response
      session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta") {
          fullResponse += event.data.deltaContent;
        }
      });

      const userPrompt = `Generate a comprehensive report for benchmark run ${requestId}. ` +
        `Start by fetching the run summary, then examine the criteria trajectory, ` +
        `and inspect individual turns for detailed analysis. ` +
        `If snapshots are available, extract and inspect key files to understand ` +
        `what the coding agent produced.`;

      const timeout = this.reportConfig.sessionTimeoutMs ?? 5 * 60 * 1000;

      await log("info", "Sending prompt to Copilot SDK, awaiting response...");
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
}
