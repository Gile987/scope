// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types/types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");
const mockOn = vi.fn();

vi.mock("ioredis", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      publish: mockPublish,
      quit: mockQuit,
      on: mockOn,
    })),
  };
});

const mockAppendLogEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../storage/blob-storage.js", () => ({
  BlobStorage: vi.fn().mockImplementation(() => ({
    appendLogEvent: mockAppendLogEvent,
  })),
}));

vi.mock("cockatiel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cockatiel")>();
  return {
    ...actual,
    circuitBreaker: vi.fn(() => ({
      execute: vi.fn((fn: () => Promise<unknown>) => fn()),
      onStateChange: vi.fn(),
      state: actual.CircuitState.Closed,
    })),
    handleAll: actual.handleAll,
    ConsecutiveBreaker: actual.ConsecutiveBreaker,
    CircuitState: actual.CircuitState,
  };
});

import { BlobStorage } from "../storage/blob-storage.js";
import { LogPublisher } from "./log-publisher.js";

const redisConfig = { redisHost: "localhost", redisPort: 6379, redisPassword: "" };

describe("LogPublisher.publish", () => {
  let blobStorage: BlobStorage;
  let publisher: LogPublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    blobStorage = new BlobStorage({ storageAccountName: "test", storageConnectionString: "UseDevelopmentStorage=true" });
    publisher = new LogPublisher(redisConfig, blobStorage, "test-source");
  });

  it("publishes to Redis channel", async () => {
    await publisher.publish("req-1", "info", "hello");

    expect(mockPublish).toHaveBeenCalledOnce();
    const [channel, payload] = mockPublish.mock.calls[0];
    expect(channel).toBe("logs:req-1");
    const event = JSON.parse(payload) as LogEvent;
    expect(event.message).toBe("hello");
    expect(event.level).toBe("info");
    expect(event.source).toBe("test-source");
  });

  it("persists to blob storage via appendLogEvent", async () => {
    await publisher.publish("req-2", "warn", "something happened");

    expect(mockAppendLogEvent).toHaveBeenCalledOnce();
    const [reqId, event] = mockAppendLogEvent.mock.calls[0] as [string, LogEvent];
    expect(reqId).toBe("req-2");
    expect(event.message).toBe("something happened");
    expect(event.level).toBe("warn");
  });

  it("includes optional data in the log event", async () => {
    await publisher.publish("req-3", "error", "oops", { code: 42 });

    const [, event] = mockAppendLogEvent.mock.calls[0] as [string, LogEvent];
    expect(event.data).toEqual({ code: 42 });
  });

  it("does not throw when blob storage fails", async () => {
    mockAppendLogEvent.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(publisher.publish("req-4", "info", "safe")).resolves.not.toThrow();
  });

  it("closes the Redis connection", async () => {
    await publisher.close();
    expect(mockQuit).toHaveBeenCalledOnce();
  });
});
