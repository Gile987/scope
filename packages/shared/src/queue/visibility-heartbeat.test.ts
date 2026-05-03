// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Test the visibility heartbeat by instantiating a minimal concrete subclass
 * of BaseQueueProcessor that exposes the protected method.
 */

// Stub external dependencies before importing the class under test.
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(),
}));

vi.mock("@azure/storage-queue", () => {
  class MockQueueClient {
    createIfNotExists = vi.fn().mockResolvedValue(undefined);
    receiveMessages = vi.fn().mockResolvedValue({ receivedMessageItems: [] });
    updateMessage = vi.fn();
    deleteMessage = vi.fn().mockResolvedValue(undefined);
  }
  return { QueueClient: MockQueueClient };
});

vi.mock("mongodb", () => {
  class MockMongoClient {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    db = vi.fn().mockReturnValue({ collection: vi.fn() });
  }
  return { MongoClient: MockMongoClient, Collection: vi.fn(), Db: vi.fn() };
});

vi.mock("../logging/log-publisher.js", () => ({
  LogPublisher: vi.fn(),
}));

vi.mock("../storage/blob-storage.js", () => ({
  BlobStorage: vi.fn(),
}));

import { BaseQueueProcessor, type VisibilityHeartbeat } from "./base-queue-processor.js";
import type { DequeuedMessageItem } from "@azure/storage-queue";
import type { LogEvent } from "../types/types.js";

// Minimal concrete subclass to test the protected method.
class TestProcessor extends BaseQueueProcessor {
  protected async handleRequest(): Promise<void> {
    // no-op
  }

  // Expose the protected method for testing.
  public testStartHeartbeat(
    ...args: Parameters<BaseQueueProcessor["startVisibilityHeartbeat"]>
  ): VisibilityHeartbeat {
    return this.startVisibilityHeartbeat(...args);
  }

  // Expose the queue client for mocking.
  public get testQueueClient() {
    return this.queueClient;
  }
}

function createProcessor(): TestProcessor {
  return new TestProcessor(
    {
      mongoUri: "mongodb://localhost:27017",
      mongoDatabase: "test",
      mongoCollection: "requests",
      storageAccountName: "teststorage",
      storageConnectionString: "UseDevelopmentStorage=true",
      queueName: "test-queue",
      batchSize: 1,
      pollIntervalMs: 1000,
      redisHost: "localhost",
      redisPort: 6379,
      redisPassword: "",
    },
    "test-worker",
  );
}

describe("visibility heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the initial pop receipt before any tick", () => {
    const proc = createProcessor();
    const hb = proc.testStartHeartbeat("msg-1", "text", "receipt-0", 30_000, 120);
    expect(hb.popReceipt).toBe("receipt-0");
    hb.stop();
  });

  it("calls updateMessage after the interval", async () => {
    const proc = createProcessor();
    const mockUpdate = vi.fn().mockResolvedValue({ popReceipt: "receipt-1" });
    (proc.testQueueClient as any).updateMessage = mockUpdate;

    const hb = proc.testStartHeartbeat("msg-1", "text", "receipt-0", 100, 120);

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(150);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith("msg-1", "receipt-0", "text", 120);
    expect(hb.popReceipt).toBe("receipt-1");

    hb.stop();
  });

  it("chains pop receipts across multiple ticks", async () => {
    const proc = createProcessor();
    let callCount = 0;
    const mockUpdate = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({ popReceipt: `receipt-${callCount}` });
    });
    (proc.testQueueClient as any).updateMessage = mockUpdate;

    const hb = proc.testStartHeartbeat("msg-1", "text", "receipt-0", 100, 120);

    // Tick 1
    await vi.advanceTimersByTimeAsync(150);
    expect(hb.popReceipt).toBe("receipt-1");
    // Second call should use receipt-1 (chained)
    expect(mockUpdate).toHaveBeenLastCalledWith("msg-1", "receipt-0", "text", 120);

    // Tick 2
    await vi.advanceTimersByTimeAsync(100);
    expect(hb.popReceipt).toBe("receipt-2");
    expect(mockUpdate).toHaveBeenLastCalledWith("msg-1", "receipt-1", "text", 120);

    hb.stop();
  });

  it("stop() is idempotent and returns latest pop receipt", async () => {
    const proc = createProcessor();
    const mockUpdate = vi.fn().mockResolvedValue({ popReceipt: "receipt-1" });
    (proc.testQueueClient as any).updateMessage = mockUpdate;

    const hb = proc.testStartHeartbeat("msg-1", "text", "receipt-0", 100, 120);

    await vi.advanceTimersByTimeAsync(150);
    const first = hb.stop();
    const second = hb.stop();
    expect(first).toBe("receipt-1");
    expect(second).toBe("receipt-1");
  });

  it("does not call updateMessage after stop", async () => {
    const proc = createProcessor();
    const mockUpdate = vi.fn().mockResolvedValue({ popReceipt: "receipt-1" });
    (proc.testQueueClient as any).updateMessage = mockUpdate;

    const hb = proc.testStartHeartbeat("msg-1", "text", "receipt-0", 100, 120);
    hb.stop();

    await vi.advanceTimersByTimeAsync(500);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("survives an updateMessage failure and retries on next tick", async () => {
    const proc = createProcessor();
    const mockUpdate = vi.fn()
      .mockRejectedValueOnce(new Error("transient 409"))
      .mockResolvedValueOnce({ popReceipt: "receipt-2" });
    (proc.testQueueClient as any).updateMessage = mockUpdate;

    const hb = proc.testStartHeartbeat("msg-1", "text", "receipt-0", 100, 120);

    // Tick 1 — fails, pop receipt stays at receipt-0
    await vi.advanceTimersByTimeAsync(150);
    expect(hb.popReceipt).toBe("receipt-0");

    // Tick 2 — succeeds with the same receipt-0 (since tick 1 failed, receipt wasn't updated)
    await vi.advanceTimersByTimeAsync(100);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith("msg-1", "receipt-0", "text", 120);
    expect(hb.popReceipt).toBe("receipt-2");

    hb.stop();
  });

  it("uses default interval and timeout from static constants", () => {
    expect(BaseQueueProcessor.HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(BaseQueueProcessor.HEARTBEAT_VISIBILITY_SECONDS).toBe(120);
  });
});
