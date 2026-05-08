// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProxyClient, deriveProxyUrlFromApi } from "./index.js";

describe("deriveProxyUrlFromApi", () => {
  it("swaps the management API port (18897) for the proxy port (18000)", () => {
    expect(deriveProxyUrlFromApi("http://devproxy-copilot:18897")).toBe(
      "http://devproxy-copilot:18000",
    );
  });

  it("works with hosts that have no scheme path", () => {
    expect(deriveProxyUrlFromApi("http://localhost:18897")).toBe(
      "http://localhost:18000",
    );
  });

  it("returns the input unchanged when it is not a valid URL", () => {
    expect(deriveProxyUrlFromApi("not-a-url")).toBe("not-a-url");
  });
});

describe("createProxyClient (devproxy backend)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.PROXY_BACKEND;
    delete process.env.DEV_PROXY_URL;
    delete process.env.DEV_PROXY_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("derives proxyUrl from apiUrl by swapping the port to 18000 when DEV_PROXY_URL is unset", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-copilot:18897";
    const client = createProxyClient();
    expect(client.backend).toBe("devproxy");
    expect(client.apiUrl).toBe("http://devproxy-copilot:18897");
    expect(client.proxyUrl).toBe("http://devproxy-copilot:18000");
  });

  it("respects DEV_PROXY_URL when it is set", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-copilot:18897";
    process.env.DEV_PROXY_URL = "http://custom-proxy:9999";
    const client = createProxyClient();
    expect(client.proxyUrl).toBe("http://custom-proxy:9999");
  });

  it("never returns the management API URL as the proxy URL", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-copilot:18897";
    const client = createProxyClient();
    // Regression guard for the bug that caused
    // "-32000 Authentication required" in the copilot worker: the worker
    // was setting HTTP_PROXY to the API port (18897), making every HTTPS
    // request fail.
    expect(client.proxyUrl).not.toBe(client.apiUrl);
    expect(client.proxyUrl).not.toContain(":18897");
  });
});
