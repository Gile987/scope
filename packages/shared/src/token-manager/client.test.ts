// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenManagerClient } from "./client.js";

describe("TokenManagerClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("acquireToken - env var fallback", () => {
    it("returns GITHUB_TOKEN env var for copilot usage", async () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot");

      expect(result).toBe("ghp_test123");
    });

    it("returns ANTHROPIC_API_KEY env var for claude-code usage", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test456";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("claude-code");

      expect(result).toBe("sk-ant-test456");
    });

    it("returns GITHUB_MODELS_API_KEY env var for github-models usage", async () => {
      process.env.GITHUB_MODELS_API_KEY = "ghm-key-789";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("github-models");

      expect(result).toBe("ghm-key-789");
    });

    it("returns GITHUB_AUTH_STATE env var for vscode-web usage", async () => {
      process.env.GITHUB_AUTH_STATE = '{"session":"data"}';
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("vscode-web");

      expect(result).toBe('{"session":"data"}');
    });

    it("does not make HTTP call when env var is set", async () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = new TokenManagerClient("http://localhost:3000");

      await client.acquireToken("copilot");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("acquireToken - API call", () => {
    it("calls Token Manager API when env var is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({
          value: "ghp_from_api",
          tokenId: "abc-123",
          usage: "copilot",
        }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");
      const result = await client.acquireToken("copilot");

      expect(result).toBe("ghp_from_api");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://token-manager:80/api/v1/tokens/acquire",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ usage: "copilot" }),
        })
      );
    });

    it("strips trailing slash from base URL", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({ value: "ghp_test", tokenId: "x", usage: "copilot" }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80///");
      await client.acquireToken("copilot");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://token-manager:80/api/v1/tokens/acquire",
        expect.anything()
      );
    });

    it("uses TOKEN_MANAGER_URL env var when no baseUrl provided", async () => {
      delete process.env.GITHUB_TOKEN;
      process.env.TOKEN_MANAGER_URL = "http://tm-from-env:80";
      const mockResponse = {
        ok: true,
        json: async () => ({ value: "ghp_env", tokenId: "x", usage: "copilot" }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient();
      await client.acquireToken("copilot");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://tm-from-env:80/api/v1/tokens/acquire",
        expect.anything()
      );
    });
  });

  describe("acquireToken - error handling", () => {
    it("throws when API returns 404 (no tokens available)", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: false,
        status: 404,
        text: async () => "No valid tokens available for usage 'copilot'",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot")).rejects.toThrow(
        /Token acquisition failed.*copilot.*404/
      );
    });

    it("throws when API returns 500", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot")).rejects.toThrow(
        /Token acquisition failed.*copilot.*500/
      );
    });

    it("throws when response has no value", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({ tokenId: "x", usage: "copilot" }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot")).rejects.toThrow(
        /Invalid token response.*copilot.*no value/
      );
    });

    it("throws when no env var and no base URL configured", async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.TOKEN_MANAGER_URL;

      const client = new TokenManagerClient();

      await expect(client.acquireToken("copilot")).rejects.toThrow(
        /No token available.*copilot.*GITHUB_TOKEN.*TOKEN_MANAGER_URL/
      );
    });
  });
});
