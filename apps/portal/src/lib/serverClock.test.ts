// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { recordServerDate, serverNow, getServerSkewMs, _resetSkewForTesting } from "./serverClock";

afterEach(() => {
  _resetSkewForTesting();
  vi.useRealTimers();
});

describe("recordServerDate", () => {
  it("ignores null/undefined values", () => {
    recordServerDate(null);
    recordServerDate(undefined);
    expect(getServerSkewMs()).toBe(0);
  });

  it("ignores unparseable date strings", () => {
    recordServerDate("not-a-date");
    expect(getServerSkewMs()).toBe(0);
  });

  it("computes a positive skew when server is ahead", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    // Server reports a time 5 seconds in the future
    recordServerDate("Thu, 15 May 2026 12:00:05 GMT");
    expect(getServerSkewMs()).toBe(5_000);
  });

  it("computes a negative skew when server is behind", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:10.000Z"));
    recordServerDate("Thu, 15 May 2026 12:00:00 GMT");
    expect(getServerSkewMs()).toBe(-10_000);
  });
});

describe("serverNow", () => {
  it("returns Date.now() when no skew recorded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    expect(serverNow()).toBe(Date.now());
  });

  it("applies skew offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    recordServerDate("Thu, 15 May 2026 12:00:03 GMT");
    expect(serverNow()).toBe(Date.now() + 3_000);
  });
});
