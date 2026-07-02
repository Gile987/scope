// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { initTelemetry, getTelemetryClient, isTelemetryEnabled, shutdownTelemetry } from "./telemetry-client.js";
export { trackMetric, trackTrace, trackEvent, trackDependency } from "./helpers.js";
export type { TelemetryMetric, TelemetryTrace, TelemetryEvent, TelemetryDependency } from "./types.js";
