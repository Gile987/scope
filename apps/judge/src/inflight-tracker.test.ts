// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InflightTracker, type InflightRedis } from "./inflight-tracker.js";

/**
 * In-memory fake of the {@link InflightRedis} surface, modelling the sorted-set
 * semantics the tracker relies on (scores are epoch-ms, members are UUIDs).
 * Records every key it is asked to touch so tests can assert the tracker only
 * ever hits the single `judge:inflight` key (cluster-safety).
 */
class FakeRedis implements InflightRedis {
  /** member -> score */
  readonly zset = new Map<string, number>();
  readonly keysSeen = new Set<string>();
  errorHandler: ((err: Error) => void) | undefined;

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.keysSeen.add(key);
    const isNew = !this.zset.has(member);
    this.zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrem(key: string, member: string): Promise<number> {
    this.keysSeen.add(key);
    return this.zset.delete(member) ? 1 : 0;
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    this.keysSeen.add(key);
    let removed = 0;
    for (const [member, score] of [...this.zset]) {
      if (score >= min && score <= max) {
        this.zset.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    this.keysSeen.add(key);
    return this.zset.size;
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }

  on(event: "error", listener: (err: Error) => void): this {
    if (event === "error") this.errorHandler = listener;
    return this;
  }
}

/** Fake whose every command rejects — exercises the tracker's fail-safe paths. */
class FailingRedis implements InflightRedis {
  quitCalled = false;
  async zadd(): Promise<never> {
    throw new Error("boom");
  }
  async zrem(): Promise<never> {
    throw new Error("boom");
  }
  async zremrangebyscore(): Promise<never> {
    throw new Error("boom");
  }
  async zcard(): Promise<number> {
    throw new Error("boom");
  }
  async quit(): Promise<"OK"> {
    this.quitCalled = true;
    throw new Error("boom");
  }
  on(): this {
    return this;
  }
}

describe("InflightTracker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe("begin / end / load counting", () => {
    it("begin() records a marker and load() reflects the count", async () => {
      const redis = new FakeRedis();
      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(0);

      const id = await tracker.begin();
      expect(id).toBeTypeOf("string");
      expect(await tracker.load()).toBe(1);
    });

    it("counts multiple concurrent evaluations and returns distinct ids", async () => {
      const tracker = new InflightTracker(new FakeRedis());

      const id1 = await tracker.begin();
      const id2 = await tracker.begin();
      const id3 = await tracker.begin();

      expect(new Set([id1, id2, id3]).size).toBe(3);
      expect(await tracker.load()).toBe(3);
    });

    it("end() clears only the marker it is given", async () => {
      const tracker = new InflightTracker(new FakeRedis());

      const id1 = await tracker.begin();
      await tracker.begin();
      expect(await tracker.load()).toBe(2);

      await tracker.end(id1);
      expect(await tracker.load()).toBe(1);
    });

    it("end(null) is a no-op and does not change the count", async () => {
      const redis = new FakeRedis();
      const tracker = new InflightTracker(redis);

      await tracker.begin();
      await tracker.end(null);

      expect(await tracker.load()).toBe(1);
      // A null id must never reach Redis as a ZREM.
      expect(redis.zset.size).toBe(1);
    });
  });

  describe("stale-marker pruning (leak-safety)", () => {
    it("prunes markers older than the default 15-minute window on load()", async () => {
      const redis = new FakeRedis();
      const now = Date.now();
      redis.zset.set("ancient", 1); // ~1970, far older than 15 minutes
      redis.zset.set("fresh", now - 1000);

      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(1);
      expect(redis.zset.has("ancient")).toBe(false);
      expect(redis.zset.has("fresh")).toBe(true);
    });

    it("honors a maxEvalAgeMs override from options", async () => {
      const redis = new FakeRedis();
      const now = Date.now();
      redis.zset.set("old", now - 5000);
      redis.zset.set("recent", now - 100);

      const tracker = new InflightTracker(redis, { maxEvalAgeMs: 1000 });

      expect(await tracker.load()).toBe(1);
      expect(redis.zset.has("old")).toBe(false);
      expect(redis.zset.has("recent")).toBe(true);
    });

    it("reads the prune window from JUDGE_MAX_EVAL_AGE_MS when no override is given", async () => {
      vi.stubEnv("JUDGE_MAX_EVAL_AGE_MS", "1000");
      const redis = new FakeRedis();
      const now = Date.now();
      redis.zset.set("old", now - 5000);
      redis.zset.set("recent", now - 100);

      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(1);
      expect(redis.zset.has("old")).toBe(false);
    });

    it("falls back to the default window for a non-positive/invalid env value", async () => {
      vi.stubEnv("JUDGE_MAX_EVAL_AGE_MS", "0");
      const redis = new FakeRedis();
      const now = Date.now();
      redis.zset.set("recent", now - 1000); // 1s old — kept under the 15-min default

      const tracker = new InflightTracker(redis);

      expect(await tracker.load()).toBe(1);
      expect(redis.zset.has("recent")).toBe(true);
    });
  });

  describe("cluster-safety", () => {
    it("only ever touches the single judge:inflight key (never a multi-key op)", async () => {
      const redis = new FakeRedis();
      const tracker = new InflightTracker(redis);

      const id = await tracker.begin();
      await tracker.load();
      await tracker.end(id);

      expect([...redis.keysSeen]).toEqual(["judge:inflight"]);
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
      const tracker = new InflightTracker(new FailingRedis());

      expect(await tracker.begin()).toBeNull();
      await expect(tracker.end("some-id")).resolves.toBeUndefined();
      expect(await tracker.load()).toBe(0);
    });

    it("close() swallows a failing quit()", async () => {
      const redis = new FailingRedis();
      const tracker = new InflightTracker(redis);

      await expect(tracker.close()).resolves.toBeUndefined();
      expect(redis.quitCalled).toBe(true);
    });

    it("registers an error handler so ioredis error events never go unhandled", () => {
      const redis = new FakeRedis();
      new InflightTracker(redis);

      expect(redis.errorHandler).toBeTypeOf("function");
      // Firing it must not throw (and only logs once).
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => {
        redis.errorHandler?.(new Error("conn reset"));
        redis.errorHandler?.(new Error("conn reset again"));
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
