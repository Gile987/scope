// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkTelemetryFlag, TelemetryFlagPoller } from "./feature-flag.js";

describe("checkTelemetryFlag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when no API URL is provided", async () => {
    expect(await checkTelemetryFlag(undefined)).toBe(false);
    expect(await checkTelemetryFlag("")).toBe(false);
  });

  it("returns true when flag is enabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { key: "mcp", enabled: true },
        { key: "telemetry", enabled: true },
      ],
    } as Response);

    expect(await checkTelemetryFlag("http://api:80")).toBe(true);
  });

  it("returns false when flag is explicitly disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { key: "mcp", enabled: true },
        { key: "telemetry", enabled: false },
      ],
    } as Response);

    expect(await checkTelemetryFlag("http://api:80")).toBe(false);
  });

  it("returns false when flag does not exist yet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { key: "mcp", enabled: true },
      ],
    } as Response);

    expect(await checkTelemetryFlag("http://api:80")).toBe(false);
  });

  it("returns false on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    expect(await checkTelemetryFlag("http://api:80")).toBe(false);
  });

  it("returns false on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await checkTelemetryFlag("http://api:80")).toBe(false);
  });

  it("returns false on timeout (abort)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal)?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    expect(await checkTelemetryFlag("http://api:80", 50)).toBe(false);
  });
});

describe("TelemetryFlagPoller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with initialValue (default false)", () => {
    const poller = new TelemetryFlagPoller("http://api:80");
    expect(poller.enabled).toBe(false);
  });

  it("starts with initialValue when provided", () => {
    const poller = new TelemetryFlagPoller("http://api:80", { initialValue: true });
    expect(poller.enabled).toBe(true);
  });

  it("poll() updates enabled state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ key: "telemetry", enabled: true }],
    } as Response);

    const poller = new TelemetryFlagPoller("http://api:80");
    expect(poller.enabled).toBe(false);

    await poller.poll();
    expect(poller.enabled).toBe(true);
  });

  it("poll() sets false when flag is disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ key: "telemetry", enabled: false }],
    } as Response);

    const poller = new TelemetryFlagPoller("http://api:80", { initialValue: true });
    await poller.poll();
    expect(poller.enabled).toBe(false);
  });

  it("periodic polling updates state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ key: "telemetry", enabled: true }],
    } as Response);

    const poller = new TelemetryFlagPoller("http://api:80", { intervalMs: 1000 });
    poller.start();

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(poller.enabled).toBe(true);

    poller.stop();
  });

  it("stop() prevents further polling", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ key: "telemetry", enabled: true }],
    } as Response);

    const poller = new TelemetryFlagPoller("http://api:80", { intervalMs: 1000 });
    poller.start();
    poller.stop();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("start() is idempotent", () => {
    const poller = new TelemetryFlagPoller("http://api:80", { intervalMs: 1000 });
    poller.start();
    poller.start(); // should not create a second timer
    poller.stop();
  });
});
