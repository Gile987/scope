// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { BaseQueueProcessor, BlobStorage, type BaseQueueProcessorConfig, type LogEvent, type VisibilityHeartbeat } from "shared";
import { POST_PROCESSOR_VERSION } from "./version.js";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "./types.js";

export interface PostProcessorConfig extends BaseQueueProcessorConfig {
  apiBaseUrl?: string;
}

interface RequestDocument {
  _id: string;
  run?: {
    _id: string;
    status: string;
    turns?: Array<{ iteration: number; harUrl?: string; atifUrl?: string }>;
    postProcessorVersion?: number;
    postProcessorStatus?: string;
  };
}

/**
 * Post-processor worker: extensible queue processor with handler registry.
 * Dispatched by the PostProcessorDispatcher in the scheduler when runs
 * complete and need post-processing (or re-processing after version bump).
 */
export class PostProcessor extends BaseQueueProcessor<RequestDocument> {
  private handlers = new Map<string, PostProcessHandler>();
  private blobStorage: BlobStorage;
  private apiBaseUrl?: string;

  constructor(config: PostProcessorConfig) {
    super(config, "post-processor");
    this.apiBaseUrl = config.apiBaseUrl;
    this.blobStorage = new BlobStorage({
      storageAccountName: config.storageAccountName,
      storageConnectionString: config.storageConnectionString,
    });
  }

  registerHandler(handler: PostProcessHandler): void {
    this.handlers.set(handler.type, handler);
    console.log(`[post-processor] Registered handler: ${handler.type}`);
  }

  protected async handleRequest(
    doc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const msg = payload as unknown as PostProcessorMessage;

    if (!msg?.type) {
      await log("warn", "Message missing 'type' field, discarding");
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const handler = this.handlers.get(msg.type);
    if (!handler) {
      await log("warn", `No handler registered for type '${msg.type}', discarding`);
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    // Set status to "processing".
    // Concurrency safety: the Azure Storage Queue guarantees at-most-once delivery
    // via visibility timeout, so only one worker processes a given message at a time.
    await this.collection.updateOne(
      { _id: doc._id } as any,
      { $set: { "run.postProcessorStatus": "processing" } } as any,
    );

    try {
      await log("info", `Running handler: ${msg.type}`);

      const ctx: HandlerContext = {
        blobStorage: this.blobStorage,
        collection: this.collection as any,
        log,
      };

      await handler.process(msg, ctx);

      // Stamp version and status on success (legacy fields + new handlerStatus)
      const handlerId = `pp-${msg.type}`; // e.g., "pp-atif"
      await this.collection.updateOne(
        { _id: doc._id } as any,
        {
          $set: {
            "run.postProcessorVersion": POST_PROCESSOR_VERSION,
            "run.postProcessorStatus": "done",
            [`run.handlerStatus.${handlerId}.status`]: "done",
            [`run.handlerStatus.${handlerId}.version`]: POST_PROCESSOR_VERSION,
            [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
          },
        } as any,
      );

      await log("info", `Post-processing complete (v${POST_PROCESSOR_VERSION})`);

      // Notify the scheduler that this handler is done (best-effort)
      await this.notifyHandlerComplete(doc._id, doc.run?._id ?? "", handlerId, "done");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await log("error", `Handler '${msg.type}' failed: ${errMsg}`);

      // Mark as failed so scheduler doesn't immediately re-dispatch
      const handlerId = `pp-${msg.type}`;
      await this.collection.updateOne(
        { _id: doc._id } as any,
        {
          $set: {
            "run.postProcessorStatus": "failed",
            [`run.handlerStatus.${handlerId}.status`]: "failed",
            [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
          },
        } as any,
      );

      // Notify scheduler of failure (best-effort — don't dispatch downstream)
      await this.notifyHandlerComplete(doc._id, doc.run?._id ?? "", handlerId, "failed");

      throw err;
    }

    // Delete queue message on success
    const popReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, popReceipt);
  }

  /**
   * Notify the scheduler that a handler completed (or failed).
   * Best-effort — the scheduler's poll safety net will catch up if this fails.
   */
  private async notifyHandlerComplete(
    requestId: string,
    runId: string,
    handlerId: string,
    status: "done" | "failed",
  ): Promise<void> {
    const schedulerUrl = process.env.SCHEDULER_URL;
    if (!schedulerUrl) return;

    try {
      const response = await fetch(`${schedulerUrl}/notify/handler-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, runId, handlerId, status }),
      });
      if (response.ok) {
        console.log(`[post-processor] Notified scheduler: ${handlerId} ${status} for ${requestId}`);
      } else {
        console.warn(`[post-processor] Scheduler notify failed: ${response.status}`);
      }
    } catch (err) {
      console.warn(`[post-processor] Scheduler notify error for ${handlerId}/${requestId}:`, err);
    }
  }
}
