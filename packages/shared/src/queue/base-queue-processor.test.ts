// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import type { BaseQueueProcessorConfig, LogEvent } from "../types/types.js";
import type { DequeuedMessageItem } from "@azure/storage-queue";

// Minimal config for testing (connections are mocked)
const testConfig: BaseQueueProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "test-collection",
  storageAccountName: "devstoreaccount1",
  storageConnectionString:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
  queueName: "test-queue",
  batchSize: 1,
  pollIntervalMs: 50,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

// Concrete subclass to test the abstract base
class TestQueueProcessor extends BaseQueueProcessor<{ _id: string; status: string; logs: LogEvent[] }> {
  public handleRequestCalls: string[] = [];
  public handleRequestDelay = 0;
  public cleanupCalled = false;

  protected async handleRequest(
    doc: { _id: string; status: string; logs: LogEvent[] },
    _message: DequeuedMessageItem,
    _currentPopReceipt: string,
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

/** Encode a queue message the same way Azure Storage Queue does. */
function makeQueueMessage(payload: Record<string, unknown>, overrides?: Partial<DequeuedMessageItem>): DequeuedMessageItem {
  return {
    messageId: "msg-1",
    popReceipt: "pop-1",
    messageText: Buffer.from(JSON.stringify(payload)).toString("base64"),
    dequeueCount: 1,
    insertedOn: new Date(),
    expiresOn: new Date(),
    nextVisibleOn: new Date(),
    ...overrides,
  };
}

/** Build the standard mock infra (mongoClient, queueClient, logPublisher, collection). */
function buildMocks(collectionOverrides?: Record<string, unknown>) {
  const mockCollection = {
    findOne: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...collectionOverrides,
  };
  const mockQueueClient = {
    createIfNotExists: vi.fn().mockResolvedValue(undefined),
    receiveMessages: vi.fn().mockResolvedValue({ receivedMessageItems: [] }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  };
  const mockMongoClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue({ collection: vi.fn().mockReturnValue(mockCollection) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockLogPublisher = {
    close: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
  return { mockCollection, mockQueueClient, mockMongoClient, mockLogPublisher };
}

function wireProcessor(processor: TestQueueProcessor, mocks: ReturnType<typeof buildMocks>) {
  (processor as any).queueClient = mocks.mockQueueClient;
  (processor as any).mongoClient = mocks.mockMongoClient;
  (processor as any).logPublisher = mocks.mockLogPublisher;
  (processor as any).collection = mocks.mockCollection;
  (processor as any).db = {};
}

describe("BaseQueueProcessor workerId", () => {
  it("generates a UUID workerId at construction time", () => {
    const p = new TestQueueProcessor(testConfig, "w");
    expect(p.workerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("each instance gets a unique workerId", () => {
    const a = new TestQueueProcessor(testConfig, "a");
    const b = new TestQueueProcessor(testConfig, "b");
    expect(a.workerId).not.toBe(b.workerId);
  });
});

describe("BaseQueueProcessor status guard", () => {
  let processor: TestQueueProcessor;
  let mocks: ReturnType<typeof buildMocks>;
  const originalExit = process.exit;

  beforeEach(() => {
    process.exit = vi.fn() as any;
    processor = new TestQueueProcessor(testConfig, "test-worker");
    mocks = buildMocks();
    wireProcessor(processor, mocks);
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("skips documents that are not in 'pending' status", async () => {
    const message = makeQueueMessage({ requestId: "doc-1" });

    // Document is already in 'processing' (e.g. picked up by another worker)
    mocks.mockCollection.findOne.mockResolvedValue({ _id: "doc-1", status: "processing" });

    // Feed one message then stop
    let callCount = 0;
    mocks.mockQueueClient.receiveMessages.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { receivedMessageItems: [message] };
      processor.requestStop();
      return { receivedMessageItems: [] };
    });

    await processor.start();

    // handleRequest should NOT have been called
    expect(processor.handleRequestCalls).toEqual([]);
    // The queue message should have been deleted (cleaned up)
    expect(mocks.mockQueueClient.deleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
  });

  it("processes documents that are in 'pending' status", async () => {
    const message = makeQueueMessage({ requestId: "doc-2" });

    mocks.mockCollection.findOne.mockResolvedValue({ _id: "doc-2", status: "pending" });

    let callCount = 0;
    mocks.mockQueueClient.receiveMessages.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { receivedMessageItems: [message] };
      processor.requestStop();
      return { receivedMessageItems: [] };
    });

    await processor.start();

    expect(processor.handleRequestCalls).toEqual(["doc-2"]);
  });
});

describe("BaseQueueProcessor heartbeat", () => {
  let processor: TestQueueProcessor;
  let mocks: ReturnType<typeof buildMocks>;
  const originalExit = process.exit;

  beforeEach(() => {
    vi.useFakeTimers();
    process.exit = vi.fn() as any;
    processor = new TestQueueProcessor(testConfig, "test-worker");
    mocks = buildMocks();
    wireProcessor(processor, mocks);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.exit = originalExit;
  });

  it("starts heartbeat on message processing and stamps heartbeatAt every 30s", async () => {
    const message = makeQueueMessage({ requestId: "doc-hb" });
    mocks.mockCollection.findOne.mockResolvedValue({ _id: "doc-hb", status: "pending" });

    // Make handleRequest take long enough for heartbeat to fire
    processor.handleRequestDelay = 100_000; // won't actually wait due to fake timers

    let callCount = 0;
    mocks.mockQueueClient.receiveMessages.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { receivedMessageItems: [message] };
      processor.requestStop();
      return { receivedMessageItems: [] };
    });

    // Start processing (will block on handleRequest due to delay)
    const startPromise = processor.start();

    // Advance time by 30s — first heartbeat should fire
    await vi.advanceTimersByTimeAsync(30_000);

    // The heartbeat should have called updateOne with heartbeatAt
    const heartbeatCalls = mocks.mockCollection.updateOne.mock.calls.filter(
      (call: any[]) => call[1]?.$set?.heartbeatAt
    );
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
    expect(heartbeatCalls[0][0]).toEqual({ _id: "doc-hb" });

    // Stop and let it finish
    processor.requestStop();
    // Resolve the handleRequest delay
    (processor as any).handleRequestDelay = 0;
    await vi.advanceTimersByTimeAsync(1000);
    await startPromise.catch(() => {}); // may reject from the abort
  });
});

describe("BaseQueueProcessor SIGTERM handler", () => {
  let processor: TestQueueProcessor;
  let mocks: ReturnType<typeof buildMocks>;
  const originalExit = process.exit;

  beforeEach(() => {
    process.exit = vi.fn() as any;
    processor = new TestQueueProcessor(testConfig, "test-worker");
    mocks = buildMocks();
    wireProcessor(processor, mocks);
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("marks in-flight document as interrupted on shutdown", async () => {
    // Simulate an in-flight document
    (processor as any).inFlightDocumentId = "doc-inflight";

    // Trigger shutdown
    await (processor as any).shutdown();

    // Should have called updateOne to set status to "interrupted"
    expect(mocks.mockCollection.updateOne).toHaveBeenCalledWith(
      { _id: "doc-inflight" },
      {
        $set: {
          status: "interrupted",
          error: "Worker shut down (SIGTERM)",
          updatedAt: expect.any(Date),
        },
      }
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("does not update any document if nothing is in-flight", async () => {
    (processor as any).inFlightDocumentId = undefined;

    await (processor as any).shutdown();

    expect(mocks.mockCollection.updateOne).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
