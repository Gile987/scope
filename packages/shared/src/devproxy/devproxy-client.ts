// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * DevProxyClient — talks to the legacy .NET DevProxy sidecar.
 *
 * Controls a DevProxy instance via its REST API (POST /proxy with
 * {recording: bool}) for recording lifecycle management.
 *
 * For the Rust gateway, use GatewayClient instead.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseHarFile } from "../har/har-parser.js";
import type { WorkerLogFn } from "../types/types.js";
import type { ProxyClient, HarCollectionResult } from "./proxy-client.js";
import {
  waitForProxyReady,
  downloadProxyCertificate,
  createCombinedCaBundle,
  extractHarMetadata,
  sleep,
} from "./proxy-client.js";

const DEFAULT_API_URL = "http://localhost:18897";
const DEFAULT_HAR_DIR = "/har-output";
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DevProxyInfo {
  recording: boolean;
  configFile: string;
}

export class DevProxyClient implements ProxyClient {
  readonly backend = "devproxy" as const;
  readonly apiUrl: string;
  private harDir: string;

  constructor(
    apiUrl: string = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL,
    harDir: string = process.env.DEV_PROXY_HAR_DIR || DEFAULT_HAR_DIR,
  ) {
    this.apiUrl = apiUrl;
    this.harDir = harDir;
  }

  /**
   * Check whether DevProxy integration is enabled via environment variable.
   * @deprecated Use {@link isProxyEnabled} from proxy-client.ts instead.
   */
  static isEnabled(): boolean {
    return !!process.env.DEV_PROXY_ENABLED;
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

  /**
   * Get current proxy status (recording state, config file).
   */
  async getStatus(): Promise<DevProxyInfo> {
    const response = await fetch(`${this.apiUrl}/proxy`);
    if (!response.ok) {
      throw new Error(`DevProxy API returned ${response.status}: ${response.statusText}`);
    }
    return response.json() as Promise<DevProxyInfo>;
  }

  /**
   * Start recording HTTP traffic.
   */
  async startRecording(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording: true }),
    });
    if (!response.ok) {
      throw new Error(`Failed to start recording: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Stop recording and wait for the HAR file to be flushed.
   * Polls until recording state is confirmed stopped.
   */
  private async stopRecording(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    const response = await fetch(`${this.apiUrl}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording: false }),
    });
    if (!response.ok) {
      throw new Error(`Failed to stop recording: ${response.status} ${response.statusText}`);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getStatus();
      if (!status.recording) {
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`DevProxy recording did not stop within ${timeoutMs}ms`);
  }

  /**
   * Find the most recent HAR file in the output directory.
   */
  async getLatestHarFile(): Promise<string | null> {
    try {
      const files = await readdir(this.harDir);
      const harFiles = files
        .filter((f) => f.startsWith("devproxy-") && f.endsWith(".har"))
        .sort()
        .reverse();
      return harFiles.length > 0 ? join(this.harDir, harFiles[0]) : null;
    } catch {
      return null;
    }
  }

  async stopAndCollectHar(log: WorkerLogFn): Promise<HarCollectionResult> {
    try {
      await this.stopRecording();
      await log("info", "DevProxy recording stopped");

      const harFilePath = await this.getLatestHarFile();
      if (harFilePath) {
        const harFromFile = await parseHarFile(harFilePath);
        return extractHarMetadata(harFromFile, harFilePath, log);
      }

      await log("warn", "No HAR file found after DevProxy recording");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await log("warn", `DevProxy HAR collection failed: ${msg}`);
    }
    return { harFilePath: null };
  }
}
