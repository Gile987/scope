// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { RedisHeartbeatStore } from "./heartbeat-store.js";

/**
 * Regression coverage for issue #1064: the heartbeat batch read must NOT use a
 * native multi-key MGET. On a clustered Redis a cross-slot MGET fails and is
 * swallowed into an empty map, which made the stuck-run reaper falsely reap
 * healthy runs and dropped heartbeats from the runs list view. The store reads
 * each key with a single-key GET pipeline, which is always shard-routable.
 */

type ExecResult = Array<[Error | null, unknown]> | null;

/** Build a store whose internal Redis client is a controllable fake. */
function storeWithFakeRedis(exec: () => ExecResult | Promise<ExecResult>) {
  const store = new RedisHeartbeatStore({
    redisHost: "localhost",
    redisPort: 6379,
    redisPassword: "",
  });
  // Drop the real client created in the constructor so it doesn't leak a
  // connection attempt, then swap in the fake.
  const real = (store as any).redis;
  real?.disconnect?.();

  const gets: string[] = [];
  const pipeline: any = {
    get: vi.fn((k: string) => {
      gets.push(k);
      return pipeline;
    }),
    exec: vi.fn(async () => exec()),
  };
  const fake = {
    pipeline: vi.fn(() => pipeline),
    mget: vi.fn(), // must never be called — MGET is not shard-safe
    on: vi.fn(),
  };
  (store as any).redis = fake;
  return { store, fake, pipeline, gets };
}

describe("RedisHeartbeatStore.mget", () => {
  it("reads each key with a single-key GET pipeline and never a multi-key MGET", async () => {
    const ts = new Date("2026-01-01T00:00:00.000Z");
    const { store, fake, gets } = storeWithFakeRedis(() => [[null, ts.toISOString()]]);

    const out = await store.mget(["run-1"]);

    expect(fake.pipeline).toHaveBeenCalledTimes(1);
    expect(fake.mget).not.toHaveBeenCalled();
    expect(gets).toEqual(["run-heartbeat:run-1"]);
    expect(out.get("run-1")).toEqual(ts);
  });

  it("recombines results by index and isolates per-key errors and misses", async () => {
    const ts = new Date("2026-02-02T12:00:00.000Z");
    const { store, gets } = storeWithFakeRedis(() => [
      [null, ts.toISOString()], // present
      [null, null], // missing key
      [new Error("MOVED 1234 10.0.0.2:6379"), null], // per-key redirect/error
    ]);

    const out = await store.mget(["a", "b", "c"]);

    expect(gets).toEqual(["run-heartbeat:a", "run-heartbeat:b", "run-heartbeat:c"]);
    expect(out.size).toBe(1);
    expect(out.get("a")).toEqual(ts);
    expect(out.has("b")).toBe(false);
    expect(out.has("c")).toBe(false);
  });

  it("returns an empty map (and does not throw) when the pipeline exec returns null", async () => {
    const { store } = storeWithFakeRedis(() => null);
    const out = await store.mget(["a", "b"]);
    expect(out.size).toBe(0);
  });

  it("returns an empty map without touching Redis for an empty id list", async () => {
    const { store, fake } = storeWithFakeRedis(() => []);
    const out = await store.mget([]);
    expect(out.size).toBe(0);
    expect(fake.pipeline).not.toHaveBeenCalled();
  });
});
