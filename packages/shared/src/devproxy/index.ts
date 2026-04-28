// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { DevProxyClient } from "./devproxy-client.js";
export type { DevProxyInfo } from "./devproxy-client.js";
export { GatewayClient } from "./gateway-client.js";
export type { ProxyClient, HarCollectionResult } from "./proxy-client.js";
export { isProxyEnabled } from "./proxy-client.js";

import { DevProxyClient } from "./devproxy-client.js";
import { GatewayClient } from "./gateway-client.js";
import { parseHarFile } from "../har/har-parser.js";
import type { ProxyClient } from "./proxy-client.js";
import { extractHarMetadata } from "../har/extract-metadata.js";

const DEFAULT_API_URL = "http://localhost:18897";

/**
 * Create the appropriate proxy client based on PROXY_BACKEND env var.
 *
 * Both backends are wrapped in a thin adapter that satisfies ProxyClient.
 * Clients handle proxy lifecycle; the adapter composes HAR collection.
 */
export function createProxyClient(): ProxyClient {
  const backend = process.env.PROXY_BACKEND || "devproxy";
  const apiUrl = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL;

  if (backend === "gateway") {
    const gw = new GatewayClient(apiUrl);
    return {
      backend: "gateway",
      apiUrl: gw.apiUrl,
      waitForReady: (t) => gw.waitForReady(t),
      downloadCertificate: (p) => gw.downloadCertificate(p),
      createCombinedCaBundle: (c, o) => gw.createCombinedCaBundle(c, o),
      startRecording: () => gw.startSession(),
      stopAndCollectHar: async (log) => {
        try {
          await gw.stopSession();
          await log("info", "Gateway session stopped");
          const har = await gw.downloadHar();
          if (har) {
            return extractHarMetadata(har, null, log);
          }
          await log("warn", "No HAR data returned from gateway");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await log("warn", `Gateway HAR collection failed: ${msg}`);
        }
        return { harFilePath: null };
      },
    };
  }

  const dp = new DevProxyClient(apiUrl);
  return {
    backend: "devproxy",
    apiUrl,
    waitForReady: (t) => dp.waitForReady(t),
    downloadCertificate: (p) => dp.downloadCertificate(p),
    createCombinedCaBundle: (c, o) => dp.createCombinedCaBundle(c, o),
    startRecording: () => dp.startRecording(),
    stopAndCollectHar: async (log) => {
      try {
        await dp.stopRecording();
        await log("info", "DevProxy recording stopped");
        const harFilePath = await dp.getLatestHarFile();
        if (harFilePath) {
          const har = await parseHarFile(harFilePath);
          return extractHarMetadata(har, harFilePath, log);
        }
        await log("warn", "No HAR file found after DevProxy recording");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `DevProxy HAR collection failed: ${msg}`);
      }
      return { harFilePath: null };
    },
  };
}
