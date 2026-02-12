// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MongoClient, Collection, Db } from "mongodb";
import { QueueClient, DequeuedMessageItem } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import {
  RequestDocument,
  QueueMessagePayload,
  WorkerProcessor,
  QueueProcessorConfig,
  LogEvent,
  MULTI_TURN_DEFAULTS,
  ConversationTurn,
} from "./types.js";
import { LogPublisher } from "./log-publisher.js";
import { BlobStorage } from "./blob-storage.js";
import { JudgeClient } from "./judge-client.js";
import { runMultiTurnLoop } from "./multi-turn-loop.js";

export class QueueProcessor {
  private mongoClient: MongoClient;
  private db!: Db;
  private collection!: Collection<RequestDocument>;
  private queueClient: QueueClient;
  private processor: WorkerProcessor;
  private config: QueueProcessorConfig;
  private logPublisher!: LogPublisher;

  constructor(config: QueueProcessorConfig, processor: WorkerProcessor) {
    this.config = config;
    this.processor = processor;

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
    console.log(`[${this.processor.workerName}] Starting worker...`);
    console.log(`[${this.processor.workerName}] MongoDB: ${this.config.mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
    console.log(`[${this.processor.workerName}] Queue: ${this.config.storageAccountName}/${this.config.queueName}`);
    console.log(`[${this.processor.workerName}] Redis: ${this.config.redisHost}:${this.config.redisPort}`);

    // Ensure queue exists (creates it in Azurite on first run)
    await this.queueClient.createIfNotExists();
    console.log(`[${this.processor.workerName}] Ensured queue exists: ${this.config.queueName}`);

    // Connect to MongoDB
    await this.mongoClient.connect();
    this.db = this.mongoClient.db(this.config.mongoDatabase);
    this.collection = this.db.collection<RequestDocument>(this.config.mongoCollection);
    console.log(`[${this.processor.workerName}] Connected to MongoDB`);

    // Initialize log publisher
    this.logPublisher = new LogPublisher(
      {
        redisHost: this.config.redisHost,
        redisPort: this.config.redisPort,
        redisPassword: this.config.redisPassword,
      },
      this.collection,
      this.processor.workerName
    );

    while (true) {
      try {
        const response = await this.queueClient.receiveMessages({
          numberOfMessages: this.config.batchSize,
          visibilityTimeout: 30,
        });

        const messages = response.receivedMessageItems;

        if (messages.length > 0) {
          console.log(`[${this.processor.workerName}] Received ${messages.length} message(s)`);

          for (const message of messages) {
            await this.processMessage(message);
          }
        }
      } catch (error) {
        console.error(`[${this.processor.workerName}] Error polling queue:`, error);
      }

      await this.sleep(this.config.pollIntervalMs);
    }
  }

  private async processMessage(message: DequeuedMessageItem): Promise<void> {
    let requestId: string | undefined;
    // Track the current pop receipt — it changes after each updateMessage call
    let currentPopReceipt = message.popReceipt;

    try {
      const decodedContent = Buffer.from(message.messageText, "base64").toString("utf-8");
      const payload: QueueMessagePayload = JSON.parse(decodedContent);
      requestId = payload.requestId;

      console.log(`[${this.processor.workerName}] Processing request ${requestId}`);

      const requestDoc = await this.collection.findOne({ _id: requestId });

      if (!requestDoc) {
        console.error(`[${this.processor.workerName}] Request ${requestId} not found`);
        await this.safeDeleteMessage(message.messageId, currentPopReceipt);
        return;
      }

      // Create log function for this request
      const log = async (
        level: LogEvent["level"],
        msg: string,
        data?: Record<string, unknown>
      ): Promise<void> => {
        await this.logPublisher.publish(requestId!, level, msg, data);
      };

      // Determine if this is a multi-turn request (criteria present in scenario)
      const isMultiTurn = requestDoc.scenario.criteria && requestDoc.scenario.criteria.length > 0;

      if (isMultiTurn) {
        currentPopReceipt = await this.processMultiTurn(requestDoc, message, currentPopReceipt, log);
      } else {
        await this.processOneShot(requestDoc, message, currentPopReceipt, log);
      }
    } catch (error) {
      console.error(`[${this.processor.workerName}] Error processing message:`, error);

      if (requestId) {
        try {
          await this.logPublisher.publish(
            requestId,
            "error",
            `Processing failed: ${error instanceof Error ? error.message : String(error)}`,
            { final: true }
          );

          await this.collection.updateOne(
            { _id: requestId },
            {
              $set: {
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                updatedAt: new Date(),
              },
            }
          );
        } catch (updateError) {
          console.error(`[${this.processor.workerName}] Failed to update request as failed:`, updateError);
        }
      }

      await this.safeDeleteMessage(message.messageId, currentPopReceipt);
    }
  }

  /**
   * Original one-shot processing (backward compatible).
   */
  private async processOneShot(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const requestId = requestDoc._id;

    // Update status to processing
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "processing", logs: [], updatedAt: new Date() } }
    );

    await log("info", `Starting processing with ${this.processor.workerName}`);

    // Process the task using the worker-specific processor
    const result = await this.processor.processMessage(requestDoc.scenario.task, log);

    await log("info", "Processing completed", { result, final: true });

    // Update request with result
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "completed", result, updatedAt: new Date() } }
    );

    console.log(`[${this.processor.workerName}] Completed request ${requestId}`);

    await this.safeDeleteMessage(message.messageId, currentPopReceipt);
  }

  /**
   * Multi-turn processing with judge loop.
   */
  private async processMultiTurn(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    currentPopReceipt: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    const requestId = requestDoc._id;
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (!judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but multi-turn request received (criteria present)");
    }

    // Update status to iterating
    await this.collection.updateOne(
      { _id: requestId },
      { $set: { status: "iterating", logs: [], turns: [], updatedAt: new Date() } }
    );

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
      console.warn(`[${this.processor.workerName}] Failed to extend message visibility: ${error}`);
    }

    await log("info", `Starting multi-turn processing with ${this.processor.workerName}`, {
      criteria: requestDoc.scenario.criteria,
      maxIterations: requestDoc.maxIterations,
    });

    const judgeClient = new JudgeClient(judgeServiceUrl);
    const blobStorage = new BlobStorage({
      storageAccountName: this.config.storageAccountName,
      storageConnectionString: this.config.storageConnectionString,
    });

    const workspacePath = process.env.WORKSPACE_PATH || "/workspace";
    const maxIterations = requestDoc.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS;

    const result = await runMultiTurnLoop({
      processor: this.processor,
      task: requestDoc.scenario.task,
      criteria: requestDoc.scenario.criteria,
      scenarioVersion: requestDoc.scenario.version,
      maxIterations,
      workspacePath,
      judgeClient,
      blobStorage,
      requestId,
      log,
      personaInstructions: requestDoc.personaInstructions,
      onTurnComplete: async (turn: ConversationTurn) => {
        // Persist each turn incrementally to MongoDB
        await this.collection.updateOne(
          { _id: requestId },
          {
            $push: { turns: turn },
            $set: { updatedAt: new Date() },
          }
        );
      },
    });

    const finalStatus = result.passed
      ? "completed"
      : result.turns.length >= maxIterations
        ? "exhausted"
        : "failed";
    await log("info", `Multi-turn processing ${finalStatus}`, {
      passed: result.passed,
      totalIterations: result.turns.length,
      final: true,
    });

    await this.collection.updateOne(
      { _id: requestId },
      {
        $set: {
          status: finalStatus,
          result: result.finalResult,
          updatedAt: new Date(),
          ...(result.passed ? {} : { error: result.finalResult }),
        },
      }
    );

    console.log(
      `[${this.processor.workerName}] Multi-turn ${finalStatus} for request ${requestId} (${result.turns.length} iterations)`
    );

    await this.safeDeleteMessage(message.messageId, currentPopReceipt);
    return currentPopReceipt;
  }

  /**
   * Delete a queue message, logging a warning instead of throwing on failure.
   * This handles cases where the pop receipt may have become stale (e.g., visibility timeout expired).
   * The message will eventually expire or be reprocessed with idempotency.
   */
  private async safeDeleteMessage(messageId: string, popReceipt: string): Promise<void> {
    try {
      await this.queueClient.deleteMessage(messageId, popReceipt);
    } catch (error) {
      console.warn(`[${this.processor.workerName}] Failed to delete queue message (may have expired or been reprocessed): ${error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
