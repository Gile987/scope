// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { DevProxyClient } from "./devproxy-client.js";
export type { DevProxyInfo, HarCollectionResult } from "./devproxy-client.js";
export { GatewayClient } from "./gateway-client.js";
export type { ProxyClient } from "./proxy-client.js";
export { isProxyEnabled } from "./proxy-client.js";

import { DevProxyClient } from "./devproxy-client.js";
import { GatewayClient } from "./gateway-client.js";
import type { ProxyClient } from "./proxy-client.js";

const DEFAULT_API_URL = "http://localhost:18897";

/**
 * Create the appropriate proxy client based on PROXY_BACKEND env var.
 *
 *   PROXY_BACKEND=gateway  → GatewayClient (implements ProxyClient directly)
 *   PROXY_BACKEND=devproxy → thin adapter over unmodified DevProxyClient
 */
export function createProxyClient(): ProxyClient {
  const backend = process.env.PROXY_BACKEND || "devproxy";
  if (backend === "gateway") {
    return new GatewayClient();
  }

  // Wrap the unchanged DevProxyClient in an adapter that adds backend/apiUrl
  const apiUrl = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL;
  const client = new DevProxyClient(apiUrl);
  return {
    backend: "devproxy",
    apiUrl,
    waitForReady: (t) => client.waitForReady(t),
    downloadCertificate: (p) => client.downloadCertificate(p),
    createCombinedCaBundle: (c, o) => client.createCombinedCaBundle(c, o),
    startRecording: () => client.startRecording(),
    stopAndCollectHar: (l) => client.stopAndCollectHar(l),
  };
}
