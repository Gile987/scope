// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GatewayClient } from "./gateway-client.js";

describe("GatewayClient", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("has backend='gateway'", () => {
      const client = new GatewayClient("http://test:18897");
      expect(client.backend).toBe("gateway");
    });

    it("uses DEV_PROXY_API_URL env var", () => {
      process.env.DEV_PROXY_API_URL = "http://env-gateway:9999";
      const client = new GatewayClient();
      expect(client.apiUrl).toBe("http://env-gateway:9999");
    });

    it("defaults to localhost:18897", () => {
      delete process.env.DEV_PROXY_API_URL;
      const client = new GatewayClient();
      expect(client.apiUrl).toBe("http://localhost:18897");
    });
  });

  describe("startRecording", () => {
    it("calls POST /session/start", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 200 })
      );

      const client = new GatewayClient("http://test:18897");
      await client.startRecording();

      expect(fetchSpy).toHaveBeenCalledWith("http://test:18897/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins: {} }),
      });
    });

    it("includes X-Session-Id header when WORKER_NAME is set", async () => {
      process.env.WORKER_NAME = "worker-42";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 200 })
      );

      const client = new GatewayClient("http://test:18897");
      await client.startRecording();

      expect(fetch).toHaveBeenCalledWith("http://test:18897/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "worker-42" },
        body: JSON.stringify({ plugins: {} }),
      });
    });

    it("throws on error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 500, statusText: "Internal Server Error" })
      );

      const client = new GatewayClient("http://test:18897");
      await expect(client.startRecording()).rejects.toThrow("Failed to start gateway session: 500");
    });
  });

  describe("stopSession", () => {
    it("calls POST /session/stop", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 200 })
      );

      const client = new GatewayClient("http://test:18897");
      await client.stopSession();

      expect(fetchSpy).toHaveBeenCalledWith("http://test:18897/session/stop", {
        method: "POST",
        headers: {},
      });
    });

    it("throws on error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 500, statusText: "Internal Server Error" })
      );

      const client = new GatewayClient("http://test:18897");
      await expect(client.stopSession()).rejects.toThrow("Failed to stop gateway session: 500");
    });
  });

  describe("downloadHar", () => {
    it("returns parsed HAR on success", async () => {
      const mockHar = { log: { version: "1.2", entries: [] } };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockHar), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const client = new GatewayClient("http://test:18897");
      const result = await client.downloadHar();

      expect(result).toEqual(mockHar);
      expect(fetch).toHaveBeenCalledWith("http://test:18897/proxy/har", { headers: {} });
    });

    it("includes X-Session-Id when WORKER_NAME is set", async () => {
      process.env.WORKER_NAME = "worker-99";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ log: { entries: [] } }), { status: 200 })
      );

      const client = new GatewayClient("http://test:18897");
      await client.downloadHar();

      expect(fetch).toHaveBeenCalledWith("http://test:18897/proxy/har", {
        headers: { "X-Session-Id": "worker-99" },
      });
    });

    it("returns null on 404", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 404 })
      );

      const client = new GatewayClient("http://test:18897");
      expect(await client.downloadHar()).toBeNull();
    });

    it("returns null on network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = new GatewayClient("http://test:18897");
      expect(await client.downloadHar()).toBeNull();
    });
  });

  describe("stopAndCollectHar", () => {
    it("stops session and downloads HAR", async () => {
      const mockHar = {
        log: {
          version: "1.2",
          creator: { name: "gateway", version: "0.1.0" },
          entries: [],
        },
      };
      vi.spyOn(globalThis, "fetch")
        // stopSession
        .mockResolvedValueOnce(new Response("", { status: 200 }))
        // downloadHar
        .mockResolvedValueOnce(
          new Response(JSON.stringify(mockHar), { status: 200 })
        );

      const log = vi.fn();
      const client = new GatewayClient("http://test:18897");
      const result = await client.stopAndCollectHar(log);

      expect(result.harFilePath).toBeNull(); // gateway serves HAR over HTTP, no file
      expect(log).toHaveBeenCalledWith("info", "Gateway session stopped");
      expect(log).toHaveBeenCalledWith("info", "HAR retrieved via gateway API");
    });

    it("returns empty result when HAR download returns null", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("", { status: 200 }))
        .mockResolvedValueOnce(new Response("", { status: 404 }));

      const log = vi.fn();
      const client = new GatewayClient("http://test:18897");
      const result = await client.stopAndCollectHar(log);

      expect(result).toEqual({ harFilePath: null });
      expect(log).toHaveBeenCalledWith("warn", "No HAR data returned from gateway");
    });

    it("handles stop failure gracefully", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 500, statusText: "Error" })
      );

      const log = vi.fn();
      const client = new GatewayClient("http://test:18897");
      const result = await client.stopAndCollectHar(log);

      expect(result).toEqual({ harFilePath: null });
      expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("Gateway HAR collection failed"));
    });
  });
});
