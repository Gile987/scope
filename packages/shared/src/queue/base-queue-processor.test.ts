// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";
import type { BaseQueueProcessorConfig, LogEvent } from "../types/types.js";
import type { DequeuedMessageItem } from "@azure/storage-queue";

// Minimal config for testing (connections are mocked)
const testConfig: BaseQueueProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "test-collection",
  storageAccountName: "devstoreaccount1",
  storageConnectionString:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
  queueName: "test-queue",
  batchSize: 1,
  pollIntervalMs: 50,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

// Concrete subclass to test the abstract base
class TestQueueProcessor extends BaseQueueProcessor<{ _id: string; status: string }> {
  public handleRequestCalls: string[] = [];
  public handleRequestDelay = 0;
  public cleanupCalled = false;

  protected async handleRequest(
    doc: { _id: string; status: string },
    _message: DequeuedMessageItem,
    _heartbeat: VisibilityHeartbeat,
    _log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    this.handleRequestCalls.push(doc._id);
    if (this.handleRequestDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.handleRequestDelay));
    }
  }

  protected override async cleanup(): Promise<void> {
    this.cleanupCalled = true;
    // Don't call super.cleanup() in tests — no real connections to close
  }

  // Expose private state for testing
  get isStopping(): boolean {
    return (this as any).stopping;
  }

  // Allow tests to trigger a graceful stop without sending real signals
  requestStop(): void {
    (this as any).stopping = true;
  }
}

describe("BaseQueueProcessor graceful shutdown", () => {
  let processor: TestQueueProcessor;
  const originalExit = process.exit;

  beforeEach(() => {
    processor = new TestQueueProcessor(testConfig, "test-worker");
    // Prevent process.exit from actually exiting during tests
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("stopping flag defaults to false", () => {
    expect(processor.isStopping).toBe(false);
  });

  it("requestStop sets stopping flag to true", () => {
    processor.requestStop();
    expect(processor.isStopping).toBe(true);
  });

  it("poll loop exits when stopping is set before start", async () => {
    // Mock external dependencies so start() doesn't fail on connection
    const mockQueueClient = {
      createIfNotExists: vi.fn().mockResolvedValue(undefined),
      receiveMessages: vi.fn().mockResolvedValue({ receivedMessageItems: [] }),
    };
    const mockMongoClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({}),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Replace internal clients with mocks
    (processor as any).queueClient = mockQueueClient;
    (processor as any).mongoClient = mockMongoClient;
    (processor as any).logPublisher = { close: vi.fn().mockResolvedValue(undefined) };

    // Set stopping before start — the poll loop should exit immediately
    processor.requestStop();

    await processor.start();

    // The poll loop should have exited, cleanup should have been called
    expect(processor.cleanupCalled).toBe(true);
    // receiveMessages should never have been called since we stopped before polling
    expect(mockQueueClient.receiveMessages).not.toHaveBeenCalled();
  });

  it("poll loop exits after processing current batch when stop is requested", async () => {
    let pollCount = 0;

    const mockQueueClient = {
      createIfNotExists: vi.fn().mockResolvedValue(undefined),
      receiveMessages: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) {
          // Stop after 2nd poll
          processor.requestStop();
        }
        return { receivedMessageItems: [] };
      }),
    };
    const mockMongoClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({}),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (processor as any).queueClient = mockQueueClient;
    (processor as any).mongoClient = mockMongoClient;
    (processor as any).logPublisher = { close: vi.fn().mockResolvedValue(undefined) };

    await processor.start();

    expect(pollCount).toBe(2);
    expect(processor.cleanupCalled).toBe(true);
  });
});
