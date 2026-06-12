// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { clusterSafeMget, type MgetCapableRedis } from "./cluster-safe-mget.js";

/**
 * Unit coverage for the cluster-safe multi-key read helper (issue #1064).
 * The helper must read each key with a single-key GET pipeline — never a
 * native cross-slot MGET — and recombine results aligned by input index,
 * isolating per-key errors and misses.
 */

type ExecResult = Array<[Error | null, unknown]> | null;

/** Build a controllable fake Redis whose pipeline records the keys it GETs. */
function fakeRedis(exec: () => ExecResult | Promise<ExecResult>) {
  const gets: string[] = [];
  const pipeline = {
    get: vi.fn((k: string) => {
      gets.push(k);
      return pipeline;
    }),
    exec: vi.fn(async () => exec()),
  };
  const redis = {
    pipeline: vi.fn(() => pipeline),
    // Present so a regression that calls native MGET would be visibly wrong.
    mget: vi.fn(),
  };
  return { redis: redis as unknown as MgetCapableRedis, raw: redis, pipeline, gets };
}

describe("clusterSafeMget", () => {
  it("reads each key with a single-key GET pipeline and never a multi-key MGET", async () => {
    const { redis, raw, pipeline, gets } = fakeRedis(() => [
      [null, "v1"],
      [null, "v2"],
    ]);

    const out = await clusterSafeMget(redis, ["k1", "k2"]);

    expect(raw.pipeline).toHaveBeenCalledTimes(1);
    expect(raw.mget).not.toHaveBeenCalled();
    expect(pipeline.get).toHaveBeenCalledTimes(2);
    expect(gets).toEqual(["k1", "k2"]);
    expect(out).toEqual(["v1", "v2"]);
  });

  it("returns values aligned by input index", async () => {
    const { redis } = fakeRedis(() => [
      [null, "a"],
      [null, "b"],
      [null, "c"],
    ]);

    const out = await clusterSafeMget(redis, ["k0", "k1", "k2"]);

    expect(out).toEqual(["a", "b", "c"]);
  });

  it("degrades a missing key, a per-key error, and a non-string value to null", async () => {
    const { redis } = fakeRedis(() => [
      [null, "present"], // present
      [null, null], // missing key
      [new Error("MOVED 1234 10.0.0.2:6379"), null], // per-key redirect/error
      [null, 42], // unexpected non-string value
    ]);

    const out = await clusterSafeMget(redis, ["a", "b", "c", "d"]);

    expect(out).toEqual(["present", null, null, null]);
  });

  it("returns all-null (same length) when the pipeline exec returns null", async () => {
    const { redis } = fakeRedis(() => null);

    const out = await clusterSafeMget(redis, ["a", "b", "c"]);

    expect(out).toEqual([null, null, null]);
  });

  it("pads with null when exec returns fewer entries than keys", async () => {
    const { redis } = fakeRedis(() => [[null, "only-one"]]);

    const out = await clusterSafeMget(redis, ["a", "b"]);

    expect(out).toEqual(["only-one", null]);
  });

  it("returns an empty array without touching Redis for an empty key list", async () => {
    const { redis, raw } = fakeRedis(() => []);

    const out = await clusterSafeMget(redis, []);

    expect(out).toEqual([]);
    expect(raw.pipeline).not.toHaveBeenCalled();
  });
});
