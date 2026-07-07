// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useAzureMonitor, shutdownAzureMonitor } from "@azure/monitor-opentelemetry";
import { metrics, type Meter } from "@opentelemetry/api";

let initialized = false;
let enabled = false;

/**
 * Initialize Azure Monitor / OpenTelemetry telemetry.
 *
 * Reads `APPLICATIONINSIGHTS_CONNECTION_STRING` from the environment.
 * If not set, telemetry is disabled and all helper functions become no-ops.
 * Must be called before any other imports that make HTTP calls (Express, MongoDB, etc.)
 * so that OpenTelemetry auto-instrumentation is applied.
 *
 * Additional configuration:
 * - `TELEMETRY_SAMPLING_RATIO` — fraction of telemetry to sample (0.0–1.0, default 1.0)
 *
 * @param serviceName - Logical name for this service (e.g., "coder-acp-copilot", "api").
 *   Sets `OTEL_SERVICE_NAME`, which becomes the resource `service.name`.
 */
export function initTelemetry(serviceName?: string): void {
  if (initialized) return;
  initialized = true;

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return;
  }

  // Azure Monitor derives the resource service.name from OTEL_SERVICE_NAME.
  if (serviceName) {
    process.env.OTEL_SERVICE_NAME = serviceName;
  }

  const samplingRatio = parseSamplingRatio(process.env.TELEMETRY_SAMPLING_RATIO);

  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio,
    enableLiveMetrics: true,
  });

  enabled = true;
}

function parseSamplingRatio(raw: string | undefined): number {
  if (!raw) return 1.0;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    return 1.0;
  }
  return parsed;
}

/**
 * Get an OpenTelemetry Meter for recording custom metrics.
 * Returns a valid (possibly no-op) Meter even when telemetry is disabled.
 */
export function getMeter(name?: string): Meter {
  return metrics.getMeter(name || "scope");
}

/**
 * Check if telemetry is actively sending data.
 */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/**
 * Reset the initialized/enabled flags. Intended for test isolation only.
 */
export function resetTelemetry(): void {
  initialized = false;
  enabled = false;
}

/**
 * Flush pending telemetry and shut down. Call during graceful shutdown.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (enabled) {
    await shutdownAzureMonitor();
  }
}
