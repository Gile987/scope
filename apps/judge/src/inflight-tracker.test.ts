// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { InflightTracker, type InflightRedis } from "./inflight-tracker.js";

/**
 * The pattern to reuse for Redis-backed unit tests: get authentic command
 * semantics from **ioredis-mock** and layer only the bespoke bits a given test
 * needs on top — here a per-test record of which keys were touched (to assert the
 * tracker's single-key cluster-safety) and optional per-method `overrides` to
 * inject failures. We deliberately do *not* hand-roll a full in-memory Redis.
 *
 * ioredis-mock keeps a single process-global data store (and pins a listener onto
 * its shared emitter per instance), so we use one shared instance and reset it in
 * `beforeEach` rather than constructing a fresh mock per test.
 */
const INFLIGHT_KEY = "judge:inflight";

const mock = new RedisMock();

/** Wrap the shared mock with a fresh key-spy (and optional failure overrides). */
function makeClient(overrides: Partial<InflightRedis> = {}) {
  const keysSeen = new Set<string>();
  const base: InflightRedis = {
    zadd: (k, s, m) => (keysSeen.add(k), mock.zadd(k, s, m)),
    zrem: (k, m) => (keysSeen.add(k), mock.zrem(k, m)),
    zremrangebyscore: (k, min, max) => (keysSeen.add(k), mock.zremrangebyscore(k, min, max)),
    zcard: (k) => (keysSeen.add(k), mock.zcard(k)),
    quit: () => mock.quit(),
    on: (event, listener) => mock.on(event, listener),
  };
  return { redis: { ...base, ...overrides }, keysSeen, mock };
}

/** Reject with a fixed error — used to build the fail-safe overrides. */
const boom = () => Promise.reject(new Error("boom"));

describe("InflightTracker", () => {
  beforeEach(async () => {
    await mock.flushall();
    // Drop error listeners registered by trackers from prior tests.
    mock.removeAllListeners("error");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("begin / end / load counting", () => {
    it("begin() records a marker and load() reflects the count", async () => {
      const { redis } = makeClient();
      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(0);

      const id = await tracker.begin();
      expect(id).toBeTypeOf("string");
      expect(await tracker.load()).toBe(1);
    });

    it("counts multiple concurrent evaluations and returns distinct ids", async () => {
      const { redis } = makeClient();
      const tracker = new InflightTracker(redis);

      const id1 = await tracker.begin();
      const id2 = await tracker.begin();
      const id3 = await tracker.begin();

      expect(new Set([id1, id2, id3]).size).toBe(3);
      expect(await tracker.load()).toBe(3);
    });

    it("end() clears only the marker it is given", async () => {
      const { redis } = makeClient();
      const tracker = new InflightTracker(redis);

      const id1 = await tracker.begin();
      await tracker.begin();
      expect(await tracker.load()).toBe(2);

      await tracker.end(id1);
      expect(await tracker.load()).toBe(1);
    });

    it("end(null) is a no-op and does not change the count", async () => {
      const { redis, mock } = makeClient();
      const tracker = new InflightTracker(redis);

      await tracker.begin();
      await tracker.end(null);

      expect(await tracker.load()).toBe(1);
      // A null id must never reach Redis as a ZREM.
      expect(await mock.zcard(INFLIGHT_KEY)).toBe(1);
    });
  });

  describe("stale-marker pruning (leak-safety)", () => {
    it("prunes markers older than the default 15-minute window on load()", async () => {
      const { redis, mock } = makeClient();
      const now = Date.now();
      await mock.zadd(INFLIGHT_KEY, 1, "ancient"); // ~1970, far older than 15 minutes
      await mock.zadd(INFLIGHT_KEY, now - 1000, "fresh");

      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(1);
      expect(await mock.zscore(INFLIGHT_KEY, "ancient")).toBeNull();
      expect(await mock.zscore(INFLIGHT_KEY, "fresh")).not.toBeNull();
    });

    it("honors a maxEvalAgeMs override from options", async () => {
      const { redis, mock } = makeClient();
      const now = Date.now();
      await mock.zadd(INFLIGHT_KEY, now - 5000, "old");
      await mock.zadd(INFLIGHT_KEY, now - 100, "recent");

      const tracker = new InflightTracker(redis, { maxEvalAgeMs: 1000 });

      expect(await tracker.load()).toBe(1);
      expect(await mock.zscore(INFLIGHT_KEY, "old")).toBeNull();
      expect(await mock.zscore(INFLIGHT_KEY, "recent")).not.toBeNull();
    });

    it("reads the prune window from JUDGE_MAX_EVAL_AGE_MS when no override is given", async () => {
      vi.stubEnv("JUDGE_MAX_EVAL_AGE_MS", "1000");
      const { redis, mock } = makeClient();
      const now = Date.now();
      await mock.zadd(INFLIGHT_KEY, now - 5000, "old");
      await mock.zadd(INFLIGHT_KEY, now - 100, "recent");

      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(1);
      expect(await mock.zscore(INFLIGHT_KEY, "old")).toBeNull();
    });

    it("falls back to the default window for a non-positive/invalid env value", async () => {
      vi.stubEnv("JUDGE_MAX_EVAL_AGE_MS", "0");
      const { redis, mock } = makeClient();
      const now = Date.now();
      await mock.zadd(INFLIGHT_KEY, now - 1000, "recent"); // 1s old — kept under the 15-min default

      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(1);
      expect(await mock.zscore(INFLIGHT_KEY, "recent")).not.toBeNull();
    });
  });

  describe("cluster-safety", () => {
    it("only ever touches the single judge:inflight key (never a multi-key op)", async () => {
      const { redis, keysSeen } = makeClient();
      const tracker = new InflightTracker(redis);

      const id = await tracker.begin();
      await tracker.load();
      await tracker.end(id);

      expect([...keysSeen]).toEqual([INFLIGHT_KEY]);
    });
  });

  describe("disabled tracker (no Redis configured)", () => {
    it("no-ops: begin() -> null, load() -> 0, end()/close() resolve", async () => {
      const tracker = new InflightTracker(null);

      expect(await tracker.begin()).toBeNull();
      expect(await tracker.load()).toBe(0);
      await expect(tracker.end(null)).resolves.toBeUndefined();
      await expect(tracker.end("anything")).resolves.toBeUndefined();
      await expect(tracker.close()).resolves.toBeUndefined();
    });
  });

  describe("fail-safe behaviour when Redis errors", () => {
    it("begin() returns null, end() swallows, load() reports 0", async () => {
      const { redis } = makeClient({
        zadd: boom,
        zrem: boom,
        zremrangebyscore: boom,
        zcard: boom,
      });
      const tracker = new InflightTracker(redis);

      expect(await tracker.begin()).toBeNull();
      await expect(tracker.end("some-id")).resolves.toBeUndefined();
      expect(await tracker.load()).toBe(0);
    });

    it("close() swallows a failing quit()", async () => {
      const quit = vi.fn(boom);
      const { redis } = makeClient({ quit });
      const tracker = new InflightTracker(redis);

      await expect(tracker.close()).resolves.toBeUndefined();
      expect(quit).toHaveBeenCalledOnce();
    });

    it("registers an error handler so ioredis error events never go unhandled", () => {
      const { redis, mock } = makeClient();
      new InflightTracker(redis);

      // The tracker attached a listener to the underlying client's "error" event.
      expect(mock.listenerCount("error")).toBeGreaterThan(0);

      // Firing it must not throw, and it logs only once.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => {
        mock.emit("error", new Error("conn reset"));
        mock.emit("error", new Error("conn reset again"));
      }).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe("fromEnv()", () => {
    beforeEach(() => {
      // Ensure the factory takes the no-op path regardless of the host env.
      vi.stubEnv("REDIS_HOST", "");
    });

    it("returns a no-op tracker when REDIS_HOST is unset", async () => {
      const tracker = InflightTracker.fromEnv();

      expect(await tracker.begin()).toBeNull();
      expect(await tracker.load()).toBe(0);
    });
  });
});
