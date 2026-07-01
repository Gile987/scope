// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { BaseQueueProcessor, BlobStorage, type BaseQueueProcessorConfig, type LogEvent, type VisibilityHeartbeat } from "shared";
import type { RequestDocument, HandlerRunStatus } from "shared";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "./types.js";

export interface PostProcessorConfig extends BaseQueueProcessorConfig {
  apiBaseUrl?: string;
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

  private isPostProcessorMessage(payload: unknown): payload is PostProcessorMessage {
    return typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).type === "string" &&
      typeof (payload as Record<string, unknown>).requestId === "string" &&
      typeof (payload as Record<string, unknown>).runId === "string";
  }

  private buildHandlerClaimFilter(
    requestId: string,
    runId: string,
    handlerId: string,
    handler: PostProcessHandler,
  ): Record<string, unknown> {
    const statusExclusions = handler.autoBackfill
      ? ["queued", "processing"]
      : ["queued", "processing", "done"];

    const filter: Record<string, unknown> = {
      _id: requestId,
      "run._id": runId,
      "run.status": "done",
      [`run.handlerStatus.${handlerId}.status`]: { $nin: statusExclusions },
    };

    if (handler.autoBackfill) {
      filter.$or = [
        { [`run.handlerStatus.${handlerId}.version`]: { $exists: false } },
        { [`run.handlerStatus.${handlerId}.version`]: { $lt: handler.version } },
      ];
    } else {
      filter[`run.handlerStatus.${handlerId}.version`] = { $exists: false };
    }

    return filter;
  }

  protected async handleRequest(
    doc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isPostProcessorMessage(payload)) {
      await log("warn", "Message missing 'type' field, discarding");
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const msg: PostProcessorMessage = payload;

    const handler = this.handlers.get(msg.type);
    if (!handler) {
      await log("warn", `No handler registered for type '${msg.type}', discarding`);
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    if (doc.run?._id !== msg.runId) {
      await log("info", "Stale post-processing message discarded (runId mismatch)", {
        messageRunId: msg.runId,
        currentRunId: doc.run?._id,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const handlerId = `pp-${msg.type}`;
    const currentStatus = doc.run?.handlerStatus?.[handlerId] as HandlerRunStatus | undefined;

    const claim = await this.collection.findOneAndUpdate(
      this.buildHandlerClaimFilter(doc._id, msg.runId, handlerId, handler) as any,
      {
        $set: {
          "run.postProcessorStatus": "processing",
          [`run.handlerStatus.${handlerId}.status`]: "processing",
          [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
        },
        $unset: {
          [`run.handlerStatus.${handlerId}.error`]: "",
        },
      } as any,
      { returnDocument: "after" },
    );

    if (!claim) {
      await log("info", "Post-processing message no longer needed, discarding", {
        handlerId,
        runId: msg.runId,
        currentStatus: currentStatus?.status,
        currentVersion: currentStatus?.version,
        targetVersion: handler.version,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    try {
      await log("info", `Running handler: ${msg.type}`);

      const ctx: HandlerContext = {
        blobStorage: this.blobStorage,
        collection: this.collection as any,
        log,
      };

      await handler.process(msg, ctx);

      // Stamp version and status on success (legacy fields + new handlerStatus)
      const successResult = await this.collection.updateOne(
        {
          _id: doc._id,
          "run._id": msg.runId,
          [`run.handlerStatus.${handlerId}.status`]: "processing",
        } as any,
        {
          $set: {
            "run.postProcessorVersion": handler.version,
            "run.postProcessorStatus": "done",
            [`run.handlerStatus.${handlerId}.status`]: "done",
            [`run.handlerStatus.${handlerId}.version`]: handler.version,
            [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
          },
        } as any,
      );

      if ((successResult.matchedCount ?? 0) === 0) {
        await log("warn", `Handler '${msg.type}' completed after state changed; skipping terminal write`, {
          handlerId,
          runId: msg.runId,
        });
        await this.safeDeleteMessage(message.messageId, heartbeat.stop());
        return;
      }

      await log("info", `Post-processing complete (v${handler.version})`);

      // Notify the scheduler that this handler is done (best-effort)
      await this.notifyHandlerComplete(doc._id, doc.run?._id ?? "", handlerId, "done");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await log("error", `Handler '${msg.type}' failed: ${errMsg}`);

      // Mark as failed so scheduler doesn't immediately re-dispatch
      const failureResult = await this.collection.updateOne(
        {
          _id: doc._id,
          "run._id": msg.runId,
          [`run.handlerStatus.${handlerId}.status`]: "processing",
        } as any,
        {
          $set: {
            "run.postProcessorStatus": "failed",
            [`run.handlerStatus.${handlerId}.status`]: "failed",
            [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
            [`run.handlerStatus.${handlerId}.error`]: errMsg,
          },
        } as any,
      );

      if ((failureResult.matchedCount ?? 0) > 0) {
        // Notify scheduler of failure (best-effort — don't dispatch downstream)
        await this.notifyHandlerComplete(doc._id, doc.run?._id ?? "", handlerId, "failed");
      }

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
