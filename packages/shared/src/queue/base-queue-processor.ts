// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, Collection, Db } from "mongodb";
import { QueueClient, DequeuedMessageItem } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { LogEvent, BaseQueueProcessorConfig } from "../types/types.js";
import { LogPublisher } from "../logging/log-publisher.js";
import { withRetry } from "../utils/retry.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Generic queue processor that polls an Azure Storage Queue and processes messages.
 * Subclasses implement `handleRequest()` to define worker-specific behavior.
 *
 * Handles: MongoDB connection, queue polling, message decoding, log publishing,
 * error handling, and message lifecycle management.
 */
export abstract class BaseQueueProcessor<TDocument extends { _id: string; status: string; logs?: LogEvent[] } = any> {
  private mongoClient: MongoClient;
  protected db!: Db;
  protected collection!: Collection<TDocument>;
  protected queueClient: QueueClient;
  protected config: BaseQueueProcessorConfig;
  protected logPublisher!: LogPublisher;
  protected workerName: string;
  readonly workerId: string;
  private stopping = false;
  private processing = false;
  private inFlightDocumentId: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: BaseQueueProcessorConfig, workerName: string) {
    this.config = config;
    this.workerName = workerName;
    this.workerId = randomUUID();

    // MongoDB client
    this.mongoClient = new MongoClient(config.mongoUri);

    // Queue client - support both Azure and Azurite
    if (config.storageConnectionString) {
      // Connection string auth (local Azurite or Azure with connection string)
      this.queueClient = new QueueClient(
        config.storageConnectionString,
        config.queueName
      );
    } else {
      // Azure with DefaultAzureCredential
      const credential = new DefaultAzureCredential();
      const queueUrl = `https://${config.storageAccountName}.queue.core.windows.net`;
      this.queueClient = new QueueClient(`${queueUrl}/${config.queueName}`, credential);
    }

    // Register graceful shutdown handlers
    const shutdown = () => this.shutdown();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  /**
   * Signal the worker to stop after finishing the current message.
   * If a document is in-flight, marks it as "interrupted" before exiting.
   */
  private async shutdown(): Promise<void> {
    if (this.stopping) return; // prevent double shutdown
    this.stopping = true;
    console.log(`[${this.workerName}] Shutdown signal received, finishing current work...`);

    // Stop heartbeat immediately
    this.stopHeartbeat();

    // If a document is in-flight, mark it as interrupted so the sweeper can recover it
    if (this.inFlightDocumentId) {
      console.log(`[${this.workerName}] Marking in-flight document ${this.inFlightDocumentId} as interrupted`);
      try {
        await withRetry(() => this.collection.updateOne(
          { _id: this.inFlightDocumentId } as any,
          {
            $set: {
              status: "interrupted",
              error: "Worker shut down (SIGTERM)",
              updatedAt: new Date(),
            },
          } as any
        ));
      } catch (err) {
        console.error(`[${this.workerName}] Failed to mark document as interrupted:`, err);
      }
    }

    await this.cleanup();
    process.exit(0);
  }

  /**
   * Close MongoDB and Redis connections. Subclasses can override to add
   * additional cleanup (e.g., killing child processes).
   */
  protected async cleanup(): Promise<void> {
    try {
      if (this.logPublisher) {
        await this.logPublisher.close();
        console.log(`[${this.workerName}] Redis connection closed`);
      }
    } catch (err) {
      console.warn(`[${this.workerName}] Error closing Redis:`, err);
    }
    try {
      await this.mongoClient.close();
      console.log(`[${this.workerName}] MongoDB connection closed`);
    } catch (err) {
      console.warn(`[${this.workerName}] Error closing MongoDB:`, err);
    }
  }

  async start(): Promise<void> {
    console.log(`[${this.workerName}] Starting worker (workerId=${this.workerId})...`);
    console.log(`[${this.workerName}] MongoDB: ${this.config.mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
    console.log(`[${this.workerName}] Queue: ${this.config.storageAccountName}/${this.config.queueName}`);
    console.log(`[${this.workerName}] Redis: ${this.config.redisHost}:${this.config.redisPort}`);

    // Ensure queue exists (creates it in Azurite on first run)
    await this.queueClient.createIfNotExists();
    console.log(`[${this.workerName}] Ensured queue exists: ${this.config.queueName}`);

    // Connect to MongoDB
    await this.mongoClient.connect();
    this.db = this.mongoClient.db(this.config.mongoDatabase);
    this.collection = this.db.collection<TDocument>(this.config.mongoCollection);
    console.log(`[${this.workerName}] Connected to MongoDB`);

    // Initialize log publisher
    this.logPublisher = new LogPublisher(
      {
        redisHost: this.config.redisHost,
        redisPort: this.config.redisPort,
        redisPassword: this.config.redisPassword,
      },
      this.collection as unknown as Collection<any>,
      this.workerName
    );

    while (!this.stopping) {
      try {
        const response = await this.queueClient.receiveMessages({
          numberOfMessages: this.config.batchSize,
          visibilityTimeout: 30,
        });

        const messages = response.receivedMessageItems;

        if (messages.length > 0) {
          console.log(`[${this.workerName}] Received ${messages.length} message(s)`);

          for (const message of messages) {
            if (this.stopping) break;
            this.processing = true;
            try {
              await this.processMessage(message);
            } finally {
              this.processing = false;
            }
          }
        }
      } catch (error) {
        if (this.stopping) break;
        console.error(`[${this.workerName}] Error polling queue:`, error);
      }

      if (!this.stopping) {
        await this.sleep(this.config.pollIntervalMs);
      }
    }

    console.log(`[${this.workerName}] Poll loop exited`);
    await this.cleanup();
  }

  private async processMessage(message: DequeuedMessageItem): Promise<void> {
    let documentId: string | undefined;
    let currentPopReceipt = message.popReceipt;

    try {
      const decodedContent = Buffer.from(message.messageText, "base64").toString("utf-8");
      const payload = JSON.parse(decodedContent);
      documentId = this.extractDocumentId(payload);

      console.log(`[${this.workerName}] Processing document ${documentId}`);

      const doc = await withRetry(() => this.collection.findOne({ _id: documentId } as any));

      if (!doc) {
        console.error(`[${this.workerName}] Document ${documentId} not found`);
        await this.safeDeleteMessage(message.messageId, currentPopReceipt);
        return;
      }

      // Status guard: only process documents that are still pending.
      // If the message re-appeared (visibility timeout expired) but another worker
      // already picked it up, or it was already processed, skip it.
      if (doc.status !== "pending") {
        console.warn(`[${this.workerName}] Document ${documentId} is '${doc.status}', expected 'pending' — skipping`);
        await this.safeDeleteMessage(message.messageId, currentPopReceipt);
        return;
      }

      // Track in-flight document for SIGTERM handler
      this.inFlightDocumentId = documentId;
      this.startHeartbeat(documentId);

      // Create log function for this document
      const log = async (
        level: LogEvent["level"],
        msg: string,
        data?: Record<string, unknown>
      ): Promise<void> => {
        await this.logPublisher.publish(documentId!, level, msg, data);
      };

      try {
        await this.handleRequest(doc as TDocument, message, currentPopReceipt, log);
      } finally {
        this.stopHeartbeat();
        this.inFlightDocumentId = undefined;
      }
    } catch (error) {
      console.error(`[${this.workerName}] Error processing message:`, error);

      // Stop heartbeat on error path (may already be stopped by inner finally)
      this.stopHeartbeat();
      this.inFlightDocumentId = undefined;

      if (documentId) {
        try {
          await this.logPublisher.publish(
            documentId,
            "error",
            `Processing failed: ${error instanceof Error ? error.message : String(error)}`,
            { final: true }
          );

          await withRetry(() => this.collection.updateOne(
            { _id: documentId } as any,
            {
              $set: {
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                updatedAt: new Date(),
              },
            } as any
          ));
        } catch (updateError) {
          console.error(`[${this.workerName}] Failed to update document as failed:`, updateError);
        }
      }

      await this.safeDeleteMessage(message.messageId, currentPopReceipt);
    }
  }

  /**
   * Start a periodic heartbeat that stamps `heartbeatAt` on the in-flight document.
   * This lets external observers (sweeper, portal) detect when a worker is alive.
   */
  private startHeartbeat(documentId: string): void {
    this.stopHeartbeat(); // clear any stale timer
    this.heartbeatTimer = setInterval(() => {
      this.collection.updateOne(
        { _id: documentId } as any,
        { $set: { heartbeatAt: new Date() } } as any
      ).catch((err) => {
        console.warn(`[${this.workerName}] Heartbeat update failed for ${documentId}:`, err);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat interval.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Extract the document ID from the decoded queue message payload.
   * Override in subclasses if the payload uses a different field name.
   * Default: `payload.requestId`
   */
  protected extractDocumentId(payload: Record<string, unknown>): string {
    return payload.requestId as string;
  }

  /**
   * Process a document fetched from MongoDB. Subclasses must implement this.
   */
  protected abstract handleRequest(
    doc: TDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<void>;

  /**
   * Delete a queue message, logging a warning instead of throwing on failure.
   */
  protected async safeDeleteMessage(messageId: string, popReceipt: string): Promise<void> {
    try {
      await this.queueClient.deleteMessage(messageId, popReceipt);
    } catch (error) {
      console.warn(`[${this.workerName}] Failed to delete queue message (may have expired or been reprocessed): ${error}`);
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
