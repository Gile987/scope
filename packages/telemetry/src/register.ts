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
 * For local development (without --import), the in-app initTelemetry("name") call
 * still works — the register module is not required, just preferred for production.
 */
import { initTelemetry } from "./telemetry-client.js";

const serviceName =
  process.env.OTEL_SERVICE_NAME ||
  process.env.WORKER_NAME ||
  "unknown";
initTelemetry(serviceName);
