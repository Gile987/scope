// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * GatewayClient — talks to the Rust TLS-intercepting gateway proxy.
 *
 * Uses the gateway session API (POST /session/start, POST /session/stop)
 * and retrieves HAR data via GET /proxy/har.
 */

import type { HarFile } from "../har/types.js";
import {
  waitForProxyReady,
  downloadProxyCertificate,
  createCombinedCaBundle,
} from "./proxy-client.js";

const DEFAULT_API_URL = "http://localhost:18897";

export class GatewayClient {
  readonly apiUrl: string;

  constructor(
    apiUrl: string = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL,
  ) {
    this.apiUrl = apiUrl;
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

  async startSession(plugins: Record<string, unknown> = {}): Promise<void> {
    const response = await fetch(`${this.apiUrl}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugins }),
    });
    if (!response.ok) {
      throw new Error(`Failed to start gateway session: ${response.status} ${response.statusText}`);
    }
  }

  async stopSession(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/session/stop`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Failed to stop gateway session: ${response.status} ${response.statusText}`);
    }
  }

  async downloadHar(): Promise<HarFile | null> {
    try {
      const response = await fetch(`${this.apiUrl}/proxy/har`);
      if (response.ok) {
        return (await response.json()) as HarFile;
      }
      return null;
    } catch {
      return null;
    }
  }
}
