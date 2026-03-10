// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileModels } from "./reconcile.js";
import type { ScanResult } from "./types.js";

describe("reconcileModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should call POST /api/v1/models/sync with correct payload", async () => {
    const mockReport = { added: ["gpt-4.1"], removed: [], unchanged: ["claude-sonnet-4"] };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockReport), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const scanResult: ScanResult = {
      provider: "github-copilot",
      models: [
        { id: "gpt-4.1" },
        {
          id: "claude-sonnet-4",
          providerAvailableFrom: new Date("2025-06-01"),
          metadata: { family: "claude" },
        },
      ],
      scannedAt: new Date("2026-02-23T10:00:00Z"),
    };

    const report = await reconcileModels(
      "http://api:80",
      "coder-acp-copilot",
      "github-copilot",
      scanResult,
    );

    expect(report).toEqual(mockReport);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://api:80/api/v1/models/sync");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string);
    expect(body.agentId).toBe("coder-acp-copilot");
    expect(body.provider).toBe("github-copilot");
    expect(body.models).toHaveLength(2);
    expect(body.models[0]).toEqual({ id: "gpt-4.1" });
    expect(body.models[1].id).toBe("claude-sonnet-4");
    expect(body.models[1].providerAvailableFrom).toBeDefined();
    expect(body.models[1].metadata).toEqual({ family: "claude" });
    expect(body.scannedAt).toBe("2026-02-23T10:00:00.000Z");
  });

  it("should strip trailing slashes from API URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ added: [], removed: [], unchanged: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const scanResult: ScanResult = {
      provider: "anthropic",
      models: [],
      scannedAt: new Date(),
    };

    await reconcileModels("http://api:80///", "test-agent", "anthropic", scanResult);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://api:80/api/v1/models/sync");
  });

  it("should throw on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const scanResult: ScanResult = {
      provider: "github-copilot",
      models: [{ id: "gpt-4.1" }],
      scannedAt: new Date(),
    };

    await expect(
      reconcileModels("http://api:80", "test-agent", "github-copilot", scanResult),
    ).rejects.toThrow("Model sync failed (HTTP 500)");
  });

  it("should omit optional fields when not present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ added: ["m1"], removed: [], unchanged: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const scanResult: ScanResult = {
      provider: "anthropic",
      models: [{ id: "m1" }],
      scannedAt: new Date(),
    };

    await reconcileModels("http://api:80", "agent", "anthropic", scanResult);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.models[0]).toEqual({ id: "m1" });
    expect(body.models[0].providerAvailableFrom).toBeUndefined();
    expect(body.models[0].providerEndOfLife).toBeUndefined();
    expect(body.models[0].metadata).toBeUndefined();
  });
});
