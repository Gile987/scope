// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import { validateToken } from "./token-validators.js";

describe("validateToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("github-pat", () => {
    it("returns valid for 200 response with scopes", async () => {
      const headers = new Headers({
        "x-oauth-scopes": "repo, read:org",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1700000000",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers,
      } as Response);

      const result = await validateToken("github-pat", "ghp_test123");

      expect(result.status).toBe("valid");
      expect(result.scopes).toEqual(["repo", "read:org"]);
      expect(result.rateLimit).toBeDefined();
      expect(result.rateLimit!.limit).toBe(5000);
      expect(result.rateLimit!.remaining).toBe(4999);
    });

    it("returns invalid for 401 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers(),
      } as Response);

      const result = await validateToken("github-pat", "ghp_bad");

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/Authentication failed/);
    });

    it("returns error for non-401 error response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
      } as Response);

      const result = await validateToken("github-pat", "ghp_test");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/500/);
    });

    it("returns error on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Network timeout")
      );

      const result = await validateToken("github-pat", "ghp_test");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Network timeout/);
    });
  });

  describe("anthropic-api-key", () => {
    it("returns valid for 200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const result = await validateToken("anthropic-api-key", "sk-ant-test");

      expect(result.status).toBe("valid");
    });

    it("returns invalid for 401 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const result = await validateToken("anthropic-api-key", "sk-ant-bad");

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/Authentication failed/);
    });

    it("returns error on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Connection refused")
      );

      const result = await validateToken("anthropic-api-key", "sk-ant-test");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Connection refused/);
    });
  });

  describe("github-models-api-key", () => {
    it("returns valid for 200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const result = await validateToken("github-models-api-key", "ghm-key");

      expect(result.status).toBe("valid");
    });

    it("returns invalid for 401 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const result = await validateToken("github-models-api-key", "ghm-bad");

      expect(result.status).toBe("invalid");
    });
  });

  describe("github-oauth-state", () => {
    it("returns valid for valid JSON object", async () => {
      const result = await validateToken(
        "github-oauth-state",
        '{"session": "data", "cookies": []}'
      );

      expect(result.status).toBe("valid");
    });

    it("returns invalid for non-JSON", async () => {
      const result = await validateToken("github-oauth-state", "not-json");

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/not valid JSON/);
    });

    it("returns invalid for non-object JSON", async () => {
      const result = await validateToken("github-oauth-state", '"just a string"');

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/not a valid JSON object/);
    });
  });

  describe("dispatcher", () => {
    it("calls correct validator for each type", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
      } as Response);

      await validateToken("github-pat", "ghp_test");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.anything()
      );

      fetchSpy.mockClear();
      await validateToken("anthropic-api-key", "sk-ant-test");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/models",
        expect.anything()
      );

      fetchSpy.mockClear();
      await validateToken("github-models-api-key", "ghm-key");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://models.inference.ai.azure.com/info",
        expect.anything()
      );
    });

    it("returns error for unknown type", async () => {
      const result = await validateToken("unknown-type" as any, "value");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Unknown token type/);
    });
  });
});
