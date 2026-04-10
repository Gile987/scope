// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types/types.js";

// ─── Mock ioredis ──────────────────────────────────────────────────────────
// log-publisher.ts uses createRequire to pull in ioredis; we mock the module.

const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock("ioredis", () => {
  const MockRedis = vi.fn(() => mockRedis);
  return { default: MockRedis, __esModule: true };
});

// ─── Mock BlobStorage ──────────────────────────────────────────────────────

const mockAppendLogEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../storage/blob-storage.js", () => ({
  BlobStorage: vi.fn().mockImplementation(() => ({
    appendLogEvent: mockAppendLogEvent,
  })),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

const { LogPublisher } = await import("./log-publisher.js");
const { BlobStorage } = await import("../storage/blob-storage.js");

// ─── Helpers ───────────────────────────────────────────────────────────────

function makePublisher() {
  const blobStorage = new (BlobStorage as any)();
  return new LogPublisher(
    { redisHost: "localhost", redisPort: 6379, redisPassword: "" },
    blobStorage,
    "test-worker",
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("LogPublisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendLogEvent.mockResolvedValue(undefined);
    mockRedis.publish.mockResolvedValue(1);
  });

  describe("publish()", () => {
    it("publishes to Redis on the correct channel", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "info", "hello");

      expect(mockRedis.publish).toHaveBeenCalledOnce();
      const [channel, payload] = mockRedis.publish.mock.calls[0];
      expect(channel).toBe("logs:run-abc");
      const parsed = JSON.parse(payload);
      expect(parsed.message).toBe("hello");
      expect(parsed.level).toBe("info");
      expect(parsed.source).toBe("test-worker");
    });

    it("persists the log event to blob storage", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "warn", "something happened");

      expect(mockAppendLogEvent).toHaveBeenCalledOnce();
      const [requestId, event] = mockAppendLogEvent.mock.calls[0];
      expect(requestId).toBe("run-abc");
      expect(event.message).toBe("something happened");
      expect(event.level).toBe("warn");
    });

    it("includes optional data in the persisted log event", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "info", "msg", { key: "value" });

      const event: LogEvent = mockAppendLogEvent.mock.calls[0][1];
      expect(event.data).toEqual({ key: "value" });
    });

    it("does not throw when Redis publish fails", async () => {
      mockRedis.publish.mockRejectedValue(new Error("Redis connection refused"));
      const publisher = makePublisher();

      await expect(publisher.publish("run-abc", "info", "msg")).resolves.toBeUndefined();
      // Blob storage must still be called even when Redis fails
      expect(mockAppendLogEvent).toHaveBeenCalledOnce();
    });

    it("does not throw when blob storage append fails after all retries", async () => {
      const err = Object.assign(new Error("BlobServiceError"), { statusCode: 500 });
      mockAppendLogEvent.mockRejectedValue(err);
      const publisher = makePublisher();

      await expect(publisher.publish("run-abc", "info", "msg")).resolves.toBeUndefined();
    });

    it("retries blob append on transient 503 before succeeding", async () => {
      const transientErr = Object.assign(new Error("ServiceUnavailable"), { statusCode: 503 });
      mockAppendLogEvent
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValueOnce(undefined);

      const publisher = makePublisher();
      await publisher.publish("run-abc", "info", "msg");

      expect(mockAppendLogEvent).toHaveBeenCalledTimes(2);
    });

    it("does not retry blob append on non-transient 400 errors", async () => {
      const badRequestErr = Object.assign(new Error("BadRequest"), { statusCode: 400 });
      // A 400 is not in the retryable list, so it should fail after 1 attempt
      mockAppendLogEvent.mockRejectedValue(badRequestErr);

      const publisher = makePublisher();
      await expect(publisher.publish("run-abc", "info", "msg")).resolves.toBeUndefined();

      // withRetry should not retry on 400 — only 1 call
      expect(mockAppendLogEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("close()", () => {
    it("calls redis.quit()", async () => {
      const publisher = makePublisher();
      await publisher.close();
      expect(mockRedis.quit).toHaveBeenCalledOnce();
    });
  });
});
