// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Side-effect-only module that initializes OpenTelemetry when loaded via
 * `node --import telemetry/register`. This ensures auto-instrumentation hooks
 * are registered before any application modules (Express, MongoDB, etc.) are loaded.
 *
 * Usage in Dockerfiles:
 *   CMD ["node", "--import", "telemetry/register", "dist/index.js"]
 *
 * The service name is resolved from env vars in priority order:
 *   OTEL_SERVICE_NAME > WORKER_NAME > "unknown"
 *
 * Checks the "telemetry" feature flag via the Scope API before initializing.
 * If the flag is disabled, telemetry is skipped entirely (no-op mode).
 * Defaults to enabled on any failure (API down, timeout, first deploy).
 *
 * For local development (without --import), the in-app initTelemetry("name") call
 * still works — the register module is not required, just preferred for production.
 */
import { initTelemetry } from "./telemetry-client.js";
import { checkTelemetryFlag } from "./feature-flag.js";

const serviceName =
  process.env.OTEL_SERVICE_NAME ||
  process.env.WORKER_NAME ||
  "unknown";

const apiUrl =
  process.env.SCOPE_API_URL ||
  process.env.SCOPE_MT_API_URL ||
  process.env.API_URL ||
  process.env.CRITERIA_API_URL;

const enabled = await checkTelemetryFlag(apiUrl);

if (enabled) {
  initTelemetry(serviceName);
} else {
  // Feature flag disabled — telemetry stays in no-op mode
  if (process.env.NODE_ENV !== "test") {
    process.stderr.write(`[telemetry] Disabled via feature flag (service: ${serviceName})\n`);
  }
}
