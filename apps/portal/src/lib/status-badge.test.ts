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

  it("pulses when processing and no heartbeat has been recorded yet", () => {
    expect(shouldPulse("processing", undefined, NOW)).toBe(true);
    expect(shouldPulse("processing", null, NOW)).toBe(true);
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
    expect(shouldPulse("processing", tenSecondsAgo, NOW, 5_000)).toBe(false);
    expect(shouldPulse("processing", tenSecondsAgo, NOW, 15_000)).toBe(true);
  });
});
