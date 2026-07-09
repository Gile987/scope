// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const useAzureMonitor = vi.fn();
const shutdownAzureMonitor = vi.fn().mockResolvedValue(undefined);

vi.mock("@azure/monitor-opentelemetry", () => ({
  useAzureMonitor: (options: unknown) => useAzureMonitor(options),
  shutdownAzureMonitor: () => shutdownAzureMonitor(),
}));

const getMeterMock = vi.fn((_name?: string) => ({}));
vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: (name?: string) => getMeterMock(name) },
}));

import {
  initTelemetry,
  isTelemetryEnabled,
  resetTelemetry,
  shutdownTelemetry,
} from "./telemetry-client.js";

describe("telemetry-client", () => {
  const savedConnStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  const savedSampling = process.env.TELEMETRY_SAMPLING_RATIO;

  beforeEach(() => {
    resetTelemetry();
    useAzureMonitor.mockClear();
    shutdownAzureMonitor.mockClear();
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.TELEMETRY_SAMPLING_RATIO;
    delete process.env.OTEL_SERVICE_NAME;
  });

  afterEach(() => {
    if (savedConnStr === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = savedConnStr;
    if (savedSampling === undefined) delete process.env.TELEMETRY_SAMPLING_RATIO;
    else process.env.TELEMETRY_SAMPLING_RATIO = savedSampling;
  });

  it("is a no-op when the connection string is not set", () => {
    initTelemetry("svc");
    expect(useAzureMonitor).not.toHaveBeenCalled();
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("initializes Azure Monitor when the connection string is set", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
    initTelemetry("my-service");
    expect(useAzureMonitor).toHaveBeenCalledTimes(1);
    expect(isTelemetryEnabled()).toBe(true);
    expect(process.env.OTEL_SERVICE_NAME).toBe("my-service");
  });

  it("passes the sampling ratio from the environment", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
    process.env.TELEMETRY_SAMPLING_RATIO = "0.25";
    initTelemetry("svc");
    expect(useAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ samplingRatio: 0.25, enableLiveMetrics: true }),
    );
  });

  it("defaults the sampling ratio to 1.0 for invalid values", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
    process.env.TELEMETRY_SAMPLING_RATIO = "not-a-number";
    initTelemetry("svc");
    expect(useAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ samplingRatio: 1.0 }),
    );
  });

  it("does not re-initialize when called multiple times", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
    initTelemetry("svc");
    initTelemetry("svc");
    initTelemetry("svc");
    expect(useAzureMonitor).toHaveBeenCalledTimes(1);
  });

  it("allows re-initialization after resetTelemetry()", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
    initTelemetry("svc");
    expect(useAzureMonitor).toHaveBeenCalledTimes(1);

    resetTelemetry();
    expect(isTelemetryEnabled()).toBe(false);

    initTelemetry("svc");
    expect(useAzureMonitor).toHaveBeenCalledTimes(2);
  });

  it("shuts down Azure Monitor only when enabled", async () => {
    await shutdownTelemetry();
    expect(shutdownAzureMonitor).not.toHaveBeenCalled();

    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
    initTelemetry("svc");
    await shutdownTelemetry();
    expect(shutdownAzureMonitor).toHaveBeenCalledTimes(1);
  });
});
