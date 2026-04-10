// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpEnvVarClient } from "./mcp-env-var-client.js";
import type { McpEnvVarListItem } from "./mcp-env-var-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
    json: () => Promise.resolve(data),
  } as Response;
}

function makeListItem(overrides: Partial<McpEnvVarListItem> = {}): McpEnvVarListItem {
  return {
    id: "abc123",
    mcpName: "my-server",
    key: "GITHUB_TOKEN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("McpEnvVarClient", () => {
  let client: McpEnvVarClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new McpEnvVarClient("http://token-manager:80");
  });

  it("strips trailing slashes from token manager URL", async () => {
    const c = new McpEnvVarClient("http://token-manager:80///");
    mockFetch.mockResolvedValueOnce(jsonResponse(makeListItem()));

    await c.storeEnv("my-server", { GITHUB_TOKEN: "ghp_test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://token-manager:80/mcp/servers/my-server/env-vars",
      expect.objectContaining({ method: "POST" }),
    );
  });

  describe("storeEnv", () => {
    it("POSTs each key-value pair to the token manager", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(makeListItem({ key: "GITHUB_TOKEN" })))
        .mockResolvedValueOnce(jsonResponse(makeListItem({ key: "API_KEY" })));

      const result = await client.storeEnv("my-server", {
        GITHUB_TOKEN: "ghp_test",
        API_KEY: "secret",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://token-manager:80/mcp/servers/my-server/env-vars",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "GITHUB_TOKEN", value: "ghp_test" }),
        }),
      );
      expect(result).toHaveLength(2);
    });

    it("returns empty array for empty env", async () => {
      const result = await client.storeEnv("my-server", {});
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
      await expect(client.storeEnv("my-server", { KEY: "val" })).rejects.toThrow("[McpEnvVarClient]");
    });
  });

  describe("listEnv", () => {
    it("GETs env var metadata (no values)", async () => {
      const items = [makeListItem({ key: "GITHUB_TOKEN" }), makeListItem({ key: "API_KEY", id: "def456" })];
      mockFetch.mockResolvedValueOnce(jsonResponse(items));

      const result = await client.listEnv("my-server");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://token-manager:80/mcp/servers/my-server/env-vars",
      );
      expect(result).toHaveLength(2);
      expect(result[0].key).toBe("GITHUB_TOKEN");
    });

    it("URL-encodes mcpName", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await client.listEnv("my server/special");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://token-manager:80/mcp/servers/my%20server%2Fspecial/env-vars",
      );
    });
  });

  describe("resolveEnv", () => {
    it("GETs resolved key/value map with ?resolve=true", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ GITHUB_TOKEN: "ghp_real" }));

      const result = await client.resolveEnv("my-server");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://token-manager:80/mcp/servers/my-server/env-vars?resolve=true",
      );
      expect(result).toEqual({ GITHUB_TOKEN: "ghp_real" });
    });
  });

  describe("deleteEnvVar", () => {
    it("DELETEs an env var by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));
      await client.deleteEnvVar("my-server", "abc123");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://token-manager:80/mcp/servers/my-server/env-vars/abc123",
        { method: "DELETE" },
      );
    });

    it("ignores 404 responses", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
      await expect(client.deleteEnvVar("my-server", "gone")).resolves.not.toThrow();
    });
  });

  describe("deleteAllEnvVars", () => {
    it("lists env vars then deletes each one", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse([makeListItem({ id: "id1" }), makeListItem({ id: "id2" })]))
        .mockResolvedValueOnce(jsonResponse(null, 204))
        .mockResolvedValueOnce(jsonResponse(null, 204));

      await client.deleteAllEnvVars("my-server");

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not throw if list call fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));
      await expect(client.deleteAllEnvVars("my-server")).resolves.not.toThrow();
    });
  });
});
