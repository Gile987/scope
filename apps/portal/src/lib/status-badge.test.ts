// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { shouldPulse } from "./status-badge";

const NOW = new Date("2026-05-15T12:00:00.000Z").getTime();

describe("shouldPulse", () => {
  it("does not pulse when status is not processing", () => {
    for (const status of ["pending", "queued", "paused", "done"] as const) {
      expect(shouldPulse(status, new Date(NOW).toISOString(), NOW)).toBe(false);
    }
  });

  it("pulses when processing and no heartbeat and no startedAt", () => {
    expect(shouldPulse("processing", undefined, NOW)).toBe(true);
    expect(shouldPulse("processing", null, NOW)).toBe(true);
    expect(shouldPulse("processing", undefined, NOW, undefined)).toBe(true);
    expect(shouldPulse("processing", null, NOW, null)).toBe(true);
  });

  it("pulses when no heartbeat but startedAt is within grace period", () => {
    const recentStart = new Date(NOW - 10_000).toISOString();
    expect(shouldPulse("processing", undefined, NOW, recentStart)).toBe(true);
    expect(shouldPulse("processing", null, NOW, recentStart)).toBe(true);
  });

  it("pulses at exactly the 60s no-heartbeat grace boundary", () => {
    const boundary = new Date(NOW - 60_000).toISOString();
    expect(shouldPulse("processing", undefined, NOW, boundary)).toBe(true);
  });

  it("does not pulse when no heartbeat and startedAt exceeds grace period", () => {
    const staleStart = new Date(NOW - 60_001).toISOString();
    expect(shouldPulse("processing", undefined, NOW, staleStart)).toBe(false);
    expect(shouldPulse("processing", null, NOW, staleStart)).toBe(false);

    const veryStaleStart = new Date(NOW - 5 * 60_000).toISOString();
    expect(shouldPulse("processing", undefined, NOW, veryStaleStart)).toBe(false);
  });

  it("treats an unparseable startedAt as fresh when no heartbeat", () => {
    expect(shouldPulse("processing", undefined, NOW, "not-a-date")).toBe(true);
  });

  it("pulses when processing and the heartbeat is fresh", () => {
    const fresh = new Date(NOW - 5_000).toISOString();
    expect(shouldPulse("processing", fresh, NOW)).toBe(true);
  });

  it("pulses at exactly the 30s freshness boundary", () => {
    const boundary = new Date(NOW - 30_000).toISOString();
    expect(shouldPulse("processing", boundary, NOW)).toBe(true);
  });

  it("does not pulse when the heartbeat is older than 30s", () => {
    const stale = new Date(NOW - 30_001).toISOString();
    expect(shouldPulse("processing", stale, NOW)).toBe(false);

    const veryStale = new Date(NOW - 5 * 60_000).toISOString();
    expect(shouldPulse("processing", veryStale, NOW)).toBe(false);
  });

  it("treats an unparseable heartbeat timestamp as fresh", () => {
    expect(shouldPulse("processing", "not-a-date", NOW)).toBe(true);
  });

  it("honours a custom staleAfterMs threshold", () => {
    const tenSecondsAgo = new Date(NOW - 10_000).toISOString();
    expect(shouldPulse("processing", tenSecondsAgo, NOW, undefined, 5_000)).toBe(false);
    expect(shouldPulse("processing", tenSecondsAgo, NOW, undefined, 15_000)).toBe(true);
  });

  it("honours a custom noHeartbeatGraceMs threshold", () => {
    const thirtySecondsAgo = new Date(NOW - 30_000).toISOString();
    expect(shouldPulse("processing", undefined, NOW, thirtySecondsAgo, 30_000, 20_000)).toBe(false);
    expect(shouldPulse("processing", undefined, NOW, thirtySecondsAgo, 30_000, 60_000)).toBe(true);
  });
});
