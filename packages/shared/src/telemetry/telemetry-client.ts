// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import appInsights from "applicationinsights";

let initialized = false;
let client: appInsights.TelemetryClient | null = null;

/**
 * Initialize Application Insights telemetry.
 *
 * Reads `APPLICATIONINSIGHTS_CONNECTION_STRING` from the environment.
 * If not set, telemetry is disabled and all helper functions become no-ops.
 * Must be called before any other imports that make HTTP calls (Express, MongoDB, etc.)
 * so that auto-instrumentation patches are applied.
 *
 * @param serviceName - Logical name for this service (e.g., "coder-acp-copilot", "api")
 */
export function initTelemetry(serviceName?: string): void {
  if (initialized) return;
  initialized = true;

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return;
  }

  appInsights.setup(connectionString)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, false)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(false)
    .start();

  client = appInsights.defaultClient;

  if (client && serviceName) {
    client.context.tags[client.context.keys.cloudRole] = serviceName;
  }
}

/**
 * Get the underlying TelemetryClient for advanced usage.
 * Returns null if telemetry is not initialized or connection string is missing.
 */
export function getTelemetryClient(): appInsights.TelemetryClient | null {
  return client;
}

/**
 * Check if telemetry is actively sending data.
 */
export function isTelemetryEnabled(): boolean {
  return client !== null;
}

/**
 * Flush pending telemetry and shut down. Call during graceful shutdown.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (client) {
    client.flush();
  }
}

