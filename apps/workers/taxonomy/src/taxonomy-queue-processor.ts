// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import {
  BaseQueueProcessor,
  BlobStorage,
  type BaseQueueProcessorConfig,
  type LogEvent,
  type RequestDocument,
  taxonomySchema,
  TokenManagerClient,
  type TaxonomyDocument,
  type VisibilityHeartbeat,
  withRetry,
} from "shared";
import { TAXONOMY_SYSTEM_PROMPT } from "./prompt.js";
import { createTaxonomyTools } from "./tools.js";

const HANDLER_ID = "pp-taxonomy";
const HANDLER_VERSION = 1;
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const DELTA_LOG_INTERVAL = 2_000;

interface TaxonomyQueueMessage {
  type: "taxonomy";
  requestId: string;
  runId?: string;
}

export interface TaxonomyQueueProcessorConfig extends BaseQueueProcessorConfig {
  taxonomyModel: string;
  apiBaseUrl: string;
  sessionTimeoutMs?: number;
  schedulerUrl?: string;
  tokenManagerUrl?: string;
}

export class TaxonomyQueueProcessor extends BaseQueueProcessor<RequestDocument> {
  private taxonomyConfig: TaxonomyQueueProcessorConfig;
  private tokenClient: TokenManagerClient;
  private blobStorage: BlobStorage;

  constructor(config: TaxonomyQueueProcessorConfig) {
    super(config, "taxonomy-handler");
    this.taxonomyConfig = config;
    this.tokenClient = new TokenManagerClient(config.tokenManagerUrl);
    this.blobStorage = new BlobStorage({
      storageAccountName: config.storageAccountName,
      storageConnectionString: config.storageConnectionString,
    });
  }

  protected override async handleRequest(
    doc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const queueMessage = payload as TaxonomyQueueMessage | undefined;
    const requestId = doc._id;
    const activeRunId = doc.run?._id;
    const runId = queueMessage?.runId ?? activeRunId ?? requestId;

    if (!queueMessage || queueMessage.type !== "taxonomy") {
      await log("warn", "Discarding message with unsupported taxonomy payload", { payload });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    if (queueMessage.runId && activeRunId && queueMessage.runId !== activeRunId) {
      await log("warn", "Discarding stale taxonomy message for superseded run", {
        requestId,
        queuedRunId: queueMessage.runId,
        activeRunId,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    if (!doc.run) {
      throw new Error(`Request ${requestId} has no active run to classify`);
    }

    await withRetry(() => this.collection.updateOne(
      { _id: requestId } as never,
      {
        $set: {
          [`run.handlerStatus.${HANDLER_ID}.status`]: "processing",
          [`run.handlerStatus.${HANDLER_ID}.version`]: HANDLER_VERSION,
          [`run.handlerStatus.${HANDLER_ID}.updatedAt`]: new Date(),
          [`run.handlerStatus.${HANDLER_ID}.error`]: null,
        },
      } as never,
    ));

    await log("info", "Starting taxonomy generation", { requestId, runId, model: this.taxonomyConfig.taxonomyModel });

    try {
      const taxonomy = await this.generateTaxonomy(requestId, runId, log);
      const blobName = `${requestId}/runs/${runId}/taxonomy.json`;
      const taxonomyUrl = await this.blobStorage.uploadJson(blobName, taxonomy);

      await withRetry(() => this.collection.updateOne(
        { _id: requestId } as never,
        {
          $set: {
            [`run.handlerStatus.${HANDLER_ID}.status`]: "done",
            [`run.handlerStatus.${HANDLER_ID}.version`]: HANDLER_VERSION,
            [`run.handlerStatus.${HANDLER_ID}.updatedAt`]: new Date(),
          },
          $unset: {
            [`run.handlerStatus.${HANDLER_ID}.error`]: "",
          },
        } as never,
      ));

      await log("info", "Taxonomy generation completed", {
        requestId,
        runId,
        blobName,
        taxonomyUrl,
      });

      await this.notifyHandlerComplete(requestId, runId, "done");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await withRetry(() => this.collection.updateOne(
        { _id: requestId } as never,
        {
          $set: {
            [`run.handlerStatus.${HANDLER_ID}.status`]: "failed",
            [`run.handlerStatus.${HANDLER_ID}.version`]: HANDLER_VERSION,
            [`run.handlerStatus.${HANDLER_ID}.updatedAt`]: new Date(),
            [`run.handlerStatus.${HANDLER_ID}.error`]: errorMessage,
          },
        } as never,
      ));

      await log("error", `Taxonomy generation failed: ${errorMessage}`, { requestId, runId });
      await this.notifyHandlerComplete(requestId, runId, "failed");
      throw error;
    }

    const finalPopReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, finalPopReceipt);
  }

  private async generateTaxonomy(
    requestId: string,
    runId: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<TaxonomyDocument> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ githubToken });
    const tools = createTaxonomyTools(this.taxonomyConfig.apiBaseUrl, requestId, this.blobStorage);
    const timeoutMs = this.taxonomyConfig.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

    let streamedResponse = "";
    let latestMessage = "";
    let lastLoggedCharCount = 0;
    const toolNames = new Map<string, string>();

    try {
      await log("info", "Acquired Copilot SDK token");

      const session = await client.createSession({
        model: this.taxonomyConfig.taxonomyModel,
        streaming: true,
        tools,
        systemMessage: { mode: "replace", content: TAXONOMY_SYSTEM_PROMPT },
      });

      session.on((event: SessionEvent) => {
        switch (event.type) {
          case "session.start":
            void log("info", "Copilot session started", {
              sessionId: event.data.sessionId,
              model: event.data.selectedModel,
            });
            break;
          case "session.error":
            void log("error", `Session error: ${event.data.message}`, { errorType: event.data.errorType });
            break;
          case "tool.execution_start":
            toolNames.set(event.data.toolCallId, event.data.toolName);
            void log("info", `Tool call: ${event.data.toolName}`, {
              toolCallId: event.data.toolCallId,
              arguments: event.data.arguments as Record<string, unknown> | undefined,
            });
            break;
          case "tool.execution_complete": {
            const toolName = toolNames.get(event.data.toolCallId) ?? "unknown";
            toolNames.delete(event.data.toolCallId);
            void log("info", `Tool result: ${toolName} (${event.data.success ? "success" : "failed"})`, {
              toolCallId: event.data.toolCallId,
              error: event.data.error?.message,
            });
            break;
          }
          case "assistant.message_delta":
            streamedResponse += event.data.deltaContent;
            if (streamedResponse.length - lastLoggedCharCount >= DELTA_LOG_INTERVAL) {
              lastLoggedCharCount = streamedResponse.length;
              void log("info", `Generating taxonomy… (${streamedResponse.length} chars so far)`);
            }
            break;
          case "assistant.message":
            latestMessage = event.data.content;
            break;
        }
      });

      let attempts = 0;
      const maxAttempts = 3;
      let prompt = [
        `Generate taxonomy JSON for request ${requestId} and run ${runId}.`,
        "Use get_run_data first, then inspect ATIF trajectories that materially affect the classification.",
        "Return only raw JSON that satisfies the taxonomy schema.",
      ].join(" ");
      let lastJson: string | undefined;

      while (attempts < maxAttempts) {
        attempts += 1;
        streamedResponse = "";
        latestMessage = "";
        lastLoggedCharCount = 0;

        await log("info", `Sending taxonomy prompt to Copilot SDK (attempt ${attempts}/${maxAttempts})`, {
          requestId,
          runId,
          timeoutMs,
        });

        const response = await session.sendAndWait({ prompt }, timeoutMs);
        const responseText = response?.data.content?.trim() || latestMessage.trim() || streamedResponse.trim();

        if (!responseText) {
          throw new Error("Copilot SDK returned an empty taxonomy response");
        }

        const jsonText = extractJson(responseText);
        lastJson = jsonText;

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(jsonText) as unknown;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (attempts >= maxAttempts) {
            throw new Error(`Taxonomy response was not valid JSON after ${maxAttempts} attempts: ${errorMessage}`);
          }

          prompt = [
            "Your previous response was not valid JSON.",
            `JSON parse error: ${errorMessage}.`,
            "Return the full taxonomy document again as raw JSON only, with no markdown fences or commentary.",
            "Replace the entire response with corrected JSON.",
          ].join(" ");
          continue;
        }

        const validation = taxonomySchema.safeParse(parsedJson);
        if (validation.success) {
          return validation.data;
        }

        const validationErrors = formatValidationErrors(validation.error.issues);
        await log("warn", `Taxonomy validation failed on attempt ${attempts}`, {
          issues: validationErrors,
        });

        if (attempts >= maxAttempts) {
          throw new Error(
            `Taxonomy schema validation failed after ${maxAttempts} attempts: ${validationErrors.join(" | ")}`,
          );
        }

        prompt = [
          "Your previous taxonomy JSON did not satisfy the schema.",
          "Correct the document and return the entire replacement JSON object.",
          "Do not include markdown fences or commentary.",
          `Validation errors: ${validationErrors.join("; ")}`,
          lastJson ? `Previous JSON: ${lastJson}` : "",
        ].filter(Boolean).join(" ");
      }

      throw new Error("Taxonomy generation ended without a valid document");
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  private async notifyHandlerComplete(
    requestId: string,
    runId: string,
    status: "done" | "failed",
  ): Promise<void> {
    const schedulerUrl = this.taxonomyConfig.schedulerUrl;
    if (!schedulerUrl) return;

    try {
      const response = await fetch(`${schedulerUrl}/notify/handler-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, runId, handlerId: HANDLER_ID, status }),
      });

      if (!response.ok) {
        console.warn(`[taxonomy-handler] Scheduler notify failed: ${response.status}`);
      }
    } catch (error) {
      console.warn(`[taxonomy-handler] Scheduler notify error for ${requestId}/${runId}:`, error);
    }
  }
}

function extractJson(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function formatValidationErrors(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}
