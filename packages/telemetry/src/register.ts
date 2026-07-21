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
 * OTel is always initialized (hooks must register before app code loads), but
 * span export is gated by the "telemetry" feature flag via a GatingSpanProcessor.
 * The flag is polled every 60 seconds — toggling it takes effect within one minute
 * without requiring a pod restart.
 *
 * For local development (without --import), the in-app initTelemetry("name") call
 * still works — the register module is not required, just preferred for production.
 */
import { initTelemetry } from "./telemetry-client.js";

const serviceName =
  process.env.OTEL_SERVICE_NAME ||
  process.env.WORKER_NAME ||
  "unknown";

const apiUrl =
  process.env.SCOPE_API_URL ||
  process.env.SCOPE_MT_API_URL ||
  process.env.API_URL ||
  process.env.CRITERIA_API_URL;

// Always initialize — OTel hooks must register before app modules load.
// The GatingSpanProcessor inside initTelemetry controls whether spans
// are actually exported, based on the feature flag polled at runtime.
initTelemetry(serviceName, { apiUrl });
