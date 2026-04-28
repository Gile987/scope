// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * GatewayClient — talks to the Rust TLS-intercepting gateway proxy.
 *
 * Uses the gateway session API (POST /session/start, POST /session/stop)
 * and retrieves HAR data via GET /proxy/har.
 */

import type { HarFile } from "../har/types.js";
import type { WorkerLogFn } from "../types/types.js";
import type { ProxyClient, HarCollectionResult } from "./proxy-client.js";
import {
  waitForProxyReady,
  downloadProxyCertificate,
  createCombinedCaBundle,
  extractHarMetadata,
} from "./proxy-client.js";

const DEFAULT_API_URL = "http://localhost:18897";

export class GatewayClient implements ProxyClient {
  readonly backend = "gateway" as const;
  readonly apiUrl: string;
  private sessionId: string | undefined;

  constructor(
    apiUrl: string = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL,
  ) {
    this.apiUrl = apiUrl;
    this.sessionId = process.env.WORKER_NAME || undefined;
  }

  private sessionHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.sessionId) {
      headers["X-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  async waitForReady(timeoutMs?: number): Promise<void> {
    return waitForProxyReady(this.apiUrl, timeoutMs);
  }

  async downloadCertificate(outputPath: string): Promise<void> {
    return downloadProxyCertificate(this.apiUrl, outputPath);
  }

  async createCombinedCaBundle(proxyCertPath: string, outputPath: string): Promise<string> {
    return createCombinedCaBundle(proxyCertPath, outputPath);
  }

  async startRecording(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.sessionHeaders() },
      body: JSON.stringify({ plugins: {} }),
    });
    if (!response.ok) {
      throw new Error(`Failed to start gateway session: ${response.status} ${response.statusText}`);
    }
  }

  async stopSession(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/session/stop`, {
      method: "POST",
      headers: this.sessionHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to stop gateway session: ${response.status} ${response.statusText}`);
    }
  }

  async downloadHar(): Promise<HarFile | null> {
    try {
      const response = await fetch(`${this.apiUrl}/proxy/har`, {
        headers: this.sessionHeaders(),
      });
      if (response.ok) {
        return (await response.json()) as HarFile;
      }
      return null;
    } catch {
      return null;
    }
  }

  async stopAndCollectHar(log: WorkerLogFn): Promise<HarCollectionResult> {
    try {
      await this.stopSession();
      await log("info", "Gateway session stopped");

      const har = await this.downloadHar();
      if (har) {
        await log("info", "HAR retrieved via gateway API");
        return extractHarMetadata(har, null, log);
      }

      await log("warn", "No HAR data returned from gateway");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await log("warn", `Gateway HAR collection failed: ${msg}`);
    }
    return { harFilePath: null };
  }
}
