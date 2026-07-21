// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { GatingSpanProcessor } from "./gating-span-processor.js";
import { TelemetryFlagPoller } from "./feature-flag.js";
import type { SpanProcessor, ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import { ROOT_CONTEXT } from "@opentelemetry/api";

function createMockProcessor(): SpanProcessor {
  return {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    forceFlush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe("GatingSpanProcessor", () => {
  it("forwards spans when flag is enabled", () => {
    const delegate = createMockProcessor();
    const poller = new TelemetryFlagPoller(undefined, { initialValue: true });
    const gating = new GatingSpanProcessor(delegate, poller);

    const span = {} as Span;
    const readableSpan = {} as ReadableSpan;

    gating.onStart(span, ROOT_CONTEXT);
    gating.onEnd(readableSpan);

    expect(delegate.onStart).toHaveBeenCalledWith(span, ROOT_CONTEXT);
    expect(delegate.onEnd).toHaveBeenCalledWith(readableSpan);
  });

  it("drops spans when flag is disabled", () => {
    const delegate = createMockProcessor();
    const poller = new TelemetryFlagPoller(undefined, { initialValue: false });
    const gating = new GatingSpanProcessor(delegate, poller);

    gating.onStart({} as Span, ROOT_CONTEXT);
    gating.onEnd({} as ReadableSpan);

    expect(delegate.onStart).not.toHaveBeenCalled();
    expect(delegate.onEnd).not.toHaveBeenCalled();
  });

  it("responds to flag changes at runtime", () => {
    const delegate = createMockProcessor();
    const poller = new TelemetryFlagPoller(undefined, { initialValue: false });
    const gating = new GatingSpanProcessor(delegate, poller);

    // Flag off — spans dropped
    gating.onEnd({} as ReadableSpan);
    expect(delegate.onEnd).not.toHaveBeenCalled();

    // Simulate flag toggle via direct property set (poll would do this)
    Object.defineProperty(poller, "enabled", { value: true, writable: true });

    // Flag on — spans forwarded
    gating.onEnd({} as ReadableSpan);
    expect(delegate.onEnd).toHaveBeenCalledTimes(1);
  });

  it("shutdown stops poller and delegates", async () => {
    const delegate = createMockProcessor();
    const poller = new TelemetryFlagPoller("http://api:80", { initialValue: false });
    const stopSpy = vi.spyOn(poller, "stop");
    const gating = new GatingSpanProcessor(delegate, poller);

    await gating.shutdown();

    expect(stopSpy).toHaveBeenCalled();
    expect(delegate.shutdown).toHaveBeenCalled();
  });

  it("forceFlush delegates", async () => {
    const delegate = createMockProcessor();
    const poller = new TelemetryFlagPoller(undefined, { initialValue: false });
    const gating = new GatingSpanProcessor(delegate, poller);

    await gating.forceFlush();

    expect(delegate.forceFlush).toHaveBeenCalled();
  });
});
