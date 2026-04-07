// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api.js";

describe("api.getReadiness", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns migrations when API is ready (200)", async () => {
    const body = {
      status: "ready",
      migrations: {
        ready: true,
        applied: ["001-backfill-task-prompts.ts", "002-create-indexes.ts"],
        pending: [],
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });

    const result = await api.getReadiness();
    expect(result.status).toBe("ready");
    expect(result.migrations.ready).toBe(true);
    expect(result.migrations.applied).toHaveLength(2);
    expect(result.migrations.pending).toHaveLength(0);
    expect(globalThis.fetch).toHaveBeenCalledWith("/ready");
  });

  it("returns migrations when API is not ready (503)", async () => {
    const body = {
      status: "not-ready",
      migrations: {
        ready: false,
        applied: ["001-backfill-task-prompts.ts"],
        pending: ["002-create-indexes.ts"],
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve(body),
    });

    const result = await api.getReadiness();
    expect(result.status).toBe("not-ready");
    expect(result.migrations.ready).toBe(false);
    expect(result.migrations.applied).toHaveLength(1);
    expect(result.migrations.pending).toHaveLength(1);
  });

  it("throws on unexpected HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Internal Server Error" }),
    });

    await expect(api.getReadiness()).rejects.toThrow("HTTP 500");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(api.getReadiness()).rejects.toThrow("Failed to fetch");
  });
});
