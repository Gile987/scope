// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getTelemetryClient } from "./telemetry-client.js";
import type { TelemetryMetric, TelemetryTrace, TelemetryEvent, TelemetryDependency } from "./types.js";

const SEVERITY_MAP: Record<string, string> = {
  Verbose: "Verbose",
  Information: "Information",
  Warning: "Warning",
  Error: "Error",
  Critical: "Critical",
};

/**
 * Record a custom metric (e.g., worker.run_duration_ms).
 * No-op if telemetry is not initialized.
 */
export function trackMetric(metric: TelemetryMetric): void {
  const client = getTelemetryClient();
  if (!client) return;

  client.trackMetric({
    name: metric.name,
    value: metric.value,
    properties: metric.properties,
  });
}

/**
 * Record a trace message (e.g., subprocess log lines).
 * No-op if telemetry is not initialized.
 */
export function trackTrace(trace: TelemetryTrace): void {
  const client = getTelemetryClient();
  if (!client) return;

  client.trackTrace({
    message: trace.message,
    severity: trace.severityLevel ? SEVERITY_MAP[trace.severityLevel] : SEVERITY_MAP.Information,
    properties: trace.properties,
  });
}

/**
 * Record a custom event (e.g., worker.version_drift).
 * No-op if telemetry is not initialized.
 */
export function trackEvent(event: TelemetryEvent): void {
  const client = getTelemetryClient();
  if (!client) return;

  client.trackEvent({
    name: event.name,
    properties: event.properties,
    measurements: event.measurements,
  });
}

/**
 * Record a dependency call (e.g., outgoing API calls, queue operations).
 * No-op if telemetry is not initialized.
 */
export function trackDependency(dep: TelemetryDependency): void {
  const client = getTelemetryClient();
  if (!client) return;

  client.trackDependency({
    name: dep.name,
    dependencyTypeName: dep.dependencyTypeName,
    duration: dep.duration,
    success: dep.success,
    data: dep.data || "",
    properties: dep.properties,
  });
}
