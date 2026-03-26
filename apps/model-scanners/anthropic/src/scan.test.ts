// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanAnthropicModels } from "./scan.js";

describe("scanAnthropicModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should parse model IDs from { data: [...] } response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-sonnet-4-20250514", type: "model", extra: "ignored" },
            { id: "claude-opus-4-20250514", display_name: "Claude Opus 4" },
          ],
          has_more: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanAnthropicModels("test-key");

    expect(result.provider).toBe("anthropic");
    expect(result.models).toHaveLength(2);
    expect(result.models.map((m) => m.id)).toEqual([
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
    ]);
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  it("should extract providerAvailableFrom from created_at (Unix timestamp)", async () => {
    const timestamp = 1715000000; // 2024-05-06T16:53:20Z
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-sonnet-4-20250514", created_at: timestamp },
          ],
          has_more: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanAnthropicModels("test-key");

    expect(result.models[0].providerAvailableFrom).toEqual(
      new Date(timestamp * 1000),
    );
  });

  it("should capture display_name and type in metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-opus-4-20250514",
              display_name: "Claude Opus 4",
              type: "model",
            },
          ],
          has_more: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanAnthropicModels("test-key");

    expect(result.models[0].metadata).toEqual({
      displayName: "Claude Opus 4",
      type: "model",
    });
  });

  it("should handle pagination with has_more", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First page
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "model-a" },
            { id: "model-b" },
          ],
          has_more: true,
        }),
        { status: 200 },
      ),
    );

    // Second page
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "model-c" },
          ],
          has_more: false,
        }),
        { status: 200 },
      ),
    );

    const result = await scanAnthropicModels("test-key");

    expect(result.models).toHaveLength(3);
    expect(result.models.map((m) => m.id)).toEqual([
      "model-a",
      "model-b",
      "model-c",
    ]);

    // Second call should include after_id
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondUrl = fetchSpy.mock.calls[1][0] as string;
    expect(secondUrl).toContain("after_id=model-b");
  });

  it("should skip entries without valid id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "valid" },
            { id: "" },
            { id: 42 },
            { display_name: "no id" },
            null,
          ],
          has_more: false,
        }),
        { status: 200 },
      ),
    );

    const result = await scanAnthropicModels("test-key");

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("valid");
  });

  it("should handle empty data array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [], has_more: false }),
        { status: 200 },
      ),
    );

    const result = await scanAnthropicModels("test-key");

    expect(result.models).toHaveLength(0);
    expect(result.provider).toBe("anthropic");
  });

  it("should send correct headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [], has_more: false }),
        { status: 200 },
      ),
    );

    await scanAnthropicModels("my-api-key");

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(
      "my-api-key",
    );
    expect(
      (init?.headers as Record<string, string>)["anthropic-version"],
    ).toBe("2023-06-01");
  });

  it("should send Bearer header for anthropic-oauth token type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [], has_more: false }),
        { status: 200 },
      ),
    );

    await scanAnthropicModels("my-oauth-token", "anthropic-oauth");

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-oauth-token",
    );
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
    expect(
      (init?.headers as Record<string, string>)["anthropic-version"],
    ).toBe("2023-06-01");
  });

  it("should default to x-api-key header when no token type specified", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [], has_more: false }),
        { status: 200 },
      ),
    );

    await scanAnthropicModels("my-api-key");

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(
      "my-api-key",
    );
    expect((init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("should throw on 401 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(scanAnthropicModels("bad-key")).rejects.toThrow(
      "Anthropic models API returned HTTP 401",
    );
  });

  it("should throw on 500 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );

    await expect(scanAnthropicModels("key")).rejects.toThrow(
      "Anthropic models API returned HTTP 500",
    );
  });

  it("should throw on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network failure"),
    );

    await expect(scanAnthropicModels("key")).rejects.toThrow(
      "Network failure",
    );
  });
});
