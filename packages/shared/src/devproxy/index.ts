// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { DevProxyClient } from "./devproxy-client.js";
export type { DevProxyInfo } from "./devproxy-client.js";
export { GatewayClient } from "./gateway-client.js";
export type { ProxyClient, HarCollectionResult } from "./proxy-client.js";
export { isProxyEnabled, createCombinedCaBundle } from "./proxy-client.js";

import { DevProxyClient } from "./devproxy-client.js";
import { GatewayClient } from "./gateway-client.js";
import type { ProxyClient } from "./proxy-client.js";

/**
 * Create the appropriate proxy client based on PROXY_BACKEND env var.
 *
 *   PROXY_BACKEND=gateway  → GatewayClient
 *   PROXY_BACKEND=devproxy → DevProxyClient  (default)
 */
export function createProxyClient(): ProxyClient {
  const backend = process.env.PROXY_BACKEND || "devproxy";
  if (backend === "gateway") {
    return new GatewayClient();
  }
  return new DevProxyClient();
}
