// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { BaseQueueProcessor, BlobStorage, type BaseQueueProcessorConfig, type LogEvent, type VisibilityHeartbeat } from "shared";
import { POST_PROCESSOR_VERSION } from "./version.js";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "./types.js";

export type PostProcessorConfig = BaseQueueProcessorConfig;

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

  constructor(config: PostProcessorConfig) {
    super(config, "post-processor");
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

    // Set status to "processing"
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

      // Stamp version and status on success
      await this.collection.updateOne(
        { _id: doc._id } as any,
        {
          $set: {
            "run.postProcessorVersion": POST_PROCESSOR_VERSION,
            "run.postProcessorStatus": "done",
          },
        } as any,
      );

      await log("info", `Post-processing complete (v${POST_PROCESSOR_VERSION})`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await log("error", `Handler '${msg.type}' failed: ${errMsg}`);

      // Mark as failed so scheduler doesn't immediately re-dispatch
      await this.collection.updateOne(
        { _id: doc._id } as any,
        { $set: { "run.postProcessorStatus": "failed" } } as any,
      );

      throw err;
    }

    // Delete queue message on success
    const popReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, popReceipt);
  }
}
