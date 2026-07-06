// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import { PromptClient } from "./prompt-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PromptClient.getText", () => {
  it("fetches resolved text from the content endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "p1", text: "# AGENTS\nBe concise." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PromptClient("https://api.example.com/");
    const text = await client.getText("p1");

    expect(text).toBe("# AGENTS\nBe concise.");
    // Trailing slash on base URL is trimmed; id is path-encoded.
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/api/v1/task-prompts/p1/content");
  });

  it("throws a clear error on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));
    const client = new PromptClient("https://api.example.com");
    await expect(client.getText("missing")).rejects.toThrow(/not found/i);
  });

  it("throws on non-OK HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));
    const client = new PromptClient("https://api.example.com");
    await expect(client.getText("p1")).rejects.toThrow(/500/);
  });

  it("throws when the response lacks a text field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "p1" }) }));
    const client = new PromptClient("https://api.example.com");
    await expect(client.getText("p1")).rejects.toThrow(/no text/i);
  });
});
