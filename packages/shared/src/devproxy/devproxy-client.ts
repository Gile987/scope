// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * DevProxy API Client
 *
 * Controls a DevProxy instance via its REST API for recording lifecycle management.
 * Used by workers to start/stop recording and download the CA certificate.
 */

import { writeFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_API_URL = "http://localhost:18897";
const DEFAULT_HAR_DIR = "/har-output";
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DevProxyInfo {
  recording: boolean;
  configFile: string;
}

export class DevProxyClient {
  private apiUrl: string;
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
   */
  static isEnabled(): boolean {
    return !!process.env.DEV_PROXY_ENABLED;
  }

  /**
   * Wait for the DevProxy sidecar to become ready.
   * Polls the proxy API endpoint until it responds successfully.
   */
  async waitForReady(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.apiUrl}/proxy`);
        if (response.ok) {
          return;
        }
      } catch {
        // DevProxy not ready yet — retry
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`DevProxy did not become ready within ${timeoutMs}ms at ${this.apiUrl}`);
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
  async stopRecording(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    const response = await fetch(`${this.apiUrl}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording: false }),
    });
    if (!response.ok) {
      throw new Error(`Failed to stop recording: ${response.status} ${response.statusText}`);
    }

    // Poll until recording is confirmed stopped
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
   * Download the DevProxy CA certificate in PEM format and write it to disk.
   * This is needed for NODE_EXTRA_CA_CERTS to trust DevProxy's MITM cert.
   */
  async downloadCertificate(outputPath: string): Promise<void> {
    // Skip if cert already exists
    try {
      await access(outputPath);
      return;
    } catch {
      // File doesn't exist — download it
    }

    const response = await fetch(`${this.apiUrl}/proxy/rootCertificate?format=crt`);
    if (!response.ok) {
      throw new Error(`Failed to download certificate: ${response.status} ${response.statusText}`);
    }
    const certData = await response.text();
    await writeFile(outputPath, certData, "utf-8");
  }

  /**
   * Find the most recent HAR file in the output directory.
   * DevProxy names files as devproxy-{timestamp}.har
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

  /**
   * List all HAR files in the output directory.
   */
  async getHarFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.harDir);
      return files
        .filter((f) => f.startsWith("devproxy-") && f.endsWith(".har"))
        .sort()
        .map((f) => join(this.harDir, f));
    } catch {
      return [];
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
