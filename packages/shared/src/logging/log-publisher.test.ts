// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types/types.js";

// ─── Mock withRetry ────────────────────────────────────────────────────────
// Replace with a synchronous pass-through to avoid real backoff delays.
// vi.mock works for ESM imports; withRetry is loaded as such.

const mockWithRetry = vi.fn();

vi.mock("../utils/retry.js", () => ({
  withRetry: mockWithRetry,
  isCosmosDb429: vi.fn().mockReturnValue(false),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

const { LogPublisher } = await import("./log-publisher.js");

// ─── Mock objects ──────────────────────────────────────────────────────────

// ioredis is loaded via createRequire() so vi.mock("ioredis") is bypassed.
// We replace the redis instance on each publisher after construction.

const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  disconnect: vi.fn(),
};

const mockAppendLogEvent = vi.fn().mockResolvedValue(undefined);

const mockBlobStorage = {
  appendLogEvent: mockAppendLogEvent,
} as any;

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Default withRetry behaviour: execute fn() once, pass result through. */
function withRetryPassthrough() {
  mockWithRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
}

function makePublisher() {
  const publisher = new LogPublisher(
    { redisHost: "127.0.0.1", redisPort: 1, redisPassword: "" },
    mockBlobStorage,
    "test-worker",
  );
  // vi.mock("ioredis") doesn't intercept createRequire-based CJS imports.
  // Disconnect the real ioredis instance to stop background reconnection,
  // then replace both redis and the circuit breaker with synchronous mocks.
  (publisher as any).redis?.disconnect?.();
  (publisher as any).redis = mockRedis;
  (publisher as any).redisBreaker = {
    execute: async (fn: () => Promise<unknown>) => fn(),
    state: "closed",
    onStateChange: vi.fn(),
  };
  return publisher;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("LogPublisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withRetryPassthrough();
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

    it("persists the log event via withRetry wrapping appendLogEvent", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "warn", "something happened");

      expect(mockWithRetry).toHaveBeenCalledOnce();
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
      expect(mockWithRetry).toHaveBeenCalledOnce();
    });

    it("does not throw when blob storage append fails after all retries", async () => {
      const err = Object.assign(new Error("BlobServiceError"), { statusCode: 500 });
      mockWithRetry.mockRejectedValue(err);
      const publisher = makePublisher();

      await expect(publisher.publish("run-abc", "info", "msg")).resolves.toBeUndefined();
    });

    it("passes an isRetryable predicate that accepts 429, 500, and 503", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "info", "msg");

      const [, opts] = mockWithRetry.mock.calls[0];
      const isRetryable = opts?.isRetryable as (err: unknown) => boolean;
      expect(isRetryable).toBeDefined();

      expect(isRetryable({ statusCode: 429 })).toBe(true);
      expect(isRetryable({ statusCode: 500 })).toBe(true);
      expect(isRetryable({ statusCode: 503 })).toBe(true);
    });

    it("passes an isRetryable predicate that rejects non-transient errors", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "info", "msg");

      const [, opts] = mockWithRetry.mock.calls[0];
      const isRetryable = opts?.isRetryable as (err: unknown) => boolean;

      expect(isRetryable({ statusCode: 400 })).toBe(false);
      expect(isRetryable({ statusCode: 404 })).toBe(false);
      expect(isRetryable({})).toBe(false);
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
