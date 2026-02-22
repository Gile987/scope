// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MongoClient, Collection, Db } from "mongodb";
import { QueueClient, DequeuedMessageItem } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { LogEvent, BaseQueueProcessorConfig } from "../types/types.js";
import { LogPublisher } from "../logging/log-publisher.js";

/**
 * Generic queue processor that polls an Azure Storage Queue and processes messages.
 * Subclasses implement `handleRequest()` to define worker-specific behavior.
 *
 * Handles: MongoDB connection, queue polling, message decoding, log publishing,
 * error handling, and message lifecycle management.
 */
export abstract class BaseQueueProcessor<TDocument extends { _id: string; status: string; logs: LogEvent[] } = any> {
  private mongoClient: MongoClient;
  protected db!: Db;
  protected collection!: Collection<TDocument>;
  protected queueClient: QueueClient;
  protected config: BaseQueueProcessorConfig;
  protected logPublisher!: LogPublisher;
  protected workerName: string;

  constructor(config: BaseQueueProcessorConfig, workerName: string) {
    this.config = config;
    this.workerName = workerName;

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
  }

  async start(): Promise<void> {
    console.log(`[${this.workerName}] Starting worker...`);
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

    while (true) {
      try {
        const response = await this.queueClient.receiveMessages({
          numberOfMessages: this.config.batchSize,
          visibilityTimeout: 30,
        });

        const messages = response.receivedMessageItems;

        if (messages.length > 0) {
          console.log(`[${this.workerName}] Received ${messages.length} message(s)`);

          for (const message of messages) {
            await this.processMessage(message);
          }
        }
      } catch (error) {
        console.error(`[${this.workerName}] Error polling queue:`, error);
      }

      await this.sleep(this.config.pollIntervalMs);
    }
  }

  private async processMessage(message: DequeuedMessageItem): Promise<void> {
    let documentId: string | undefined;
    let currentPopReceipt = message.popReceipt;

    try {
      const decodedContent = Buffer.from(message.messageText, "base64").toString("utf-8");
      const payload = JSON.parse(decodedContent);
      documentId = this.extractDocumentId(payload);

      console.log(`[${this.workerName}] Processing document ${documentId}`);

      const doc = await this.collection.findOne({ _id: documentId } as any);

      if (!doc) {
        console.error(`[${this.workerName}] Document ${documentId} not found`);
        await this.safeDeleteMessage(message.messageId, currentPopReceipt);
        return;
      }

      // Create log function for this document
      const log = async (
        level: LogEvent["level"],
        msg: string,
        data?: Record<string, unknown>
      ): Promise<void> => {
        await this.logPublisher.publish(documentId!, level, msg, data);
      };

      await this.handleRequest(doc as TDocument, message, currentPopReceipt, log);
    } catch (error) {
      console.error(`[${this.workerName}] Error processing message:`, error);

      if (documentId) {
        try {
          await this.logPublisher.publish(
            documentId,
            "error",
            `Processing failed: ${error instanceof Error ? error.message : String(error)}`,
            { final: true }
          );

          await this.collection.updateOne(
            { _id: documentId } as any,
            {
              $set: {
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                updatedAt: new Date(),
              },
            } as any
          );
        } catch (updateError) {
          console.error(`[${this.workerName}] Failed to update document as failed:`, updateError);
        }
      }

      await this.safeDeleteMessage(message.messageId, currentPopReceipt);
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
