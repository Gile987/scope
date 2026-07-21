// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkTelemetryFlag } from "./feature-flag.js";

describe("checkTelemetryFlag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when no API URL is provided", async () => {
    expect(await checkTelemetryFlag(undefined)).toBe(true);
    expect(await checkTelemetryFlag("")).toBe(true);
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

  it("returns true when flag does not exist yet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { key: "mcp", enabled: true },
      ],
    } as Response);

    expect(await checkTelemetryFlag("http://api:80")).toBe(true);
  });

  it("returns true on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    expect(await checkTelemetryFlag("http://api:80")).toBe(true);
  });

  it("returns true on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await checkTelemetryFlag("http://api:80")).toBe(true);
  });

  it("returns true on timeout (abort)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      // Simulate a slow response that gets aborted
      return new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal)?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    expect(await checkTelemetryFlag("http://api:80", 50)).toBe(true);
  });
});
