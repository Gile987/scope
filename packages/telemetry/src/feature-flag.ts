// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Checks the telemetry feature flag via the Scope API.
 *
 * Returns `true` if telemetry should be enabled, `false` if explicitly disabled.
 * Defaults to `true` on any failure (network error, timeout, API down) —
 * telemetry should never block service startup.
 *
 * @param apiUrl - Base URL of the Scope API (e.g. "http://api.scoped.svc.cluster.local:80")
 * @param timeoutMs - Maximum time to wait for the flag check (default: 2000ms)
 */
export async function checkTelemetryFlag(
  apiUrl: string | undefined,
  timeoutMs = 2000,
): Promise<boolean> {
  if (!apiUrl) return true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${apiUrl}/api/v1/feature-flags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return true;

    const flags = (await response.json()) as Array<{ key: string; enabled: boolean }>;
    const telemetryFlag = flags.find((f) => f.key === "telemetry");

    // If flag doesn't exist yet (first deploy), default to enabled
    return telemetryFlag?.enabled ?? true;
  } catch {
    // Network error, timeout, API not ready — default to enabled
    return true;
  }
}
