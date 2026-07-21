// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Span } from "@opentelemetry/sdk-trace-base";
import type { TelemetryFlagPoller } from "./feature-flag.js";

/**
 * A SpanProcessor that gates span export based on a feature flag poller.
 *
 * When the flag is enabled, spans are forwarded to the delegate processor.
 * When disabled, spans are silently dropped — zero export, minimal overhead.
 *
 * This allows runtime toggling of telemetry without restarting pods.
 * OTel auto-instrumentation stays active (hooks can't be removed), but
 * no data leaves the process when the gate is closed.
 */
export class GatingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly delegate: SpanProcessor,
    private readonly poller: TelemetryFlagPoller,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    if (this.poller.enabled) {
      this.delegate.onStart(span, parentContext);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.poller.enabled) {
      this.delegate.onEnd(span);
    }
  }

  async shutdown(): Promise<void> {
    this.poller.stop();
    return this.delegate.shutdown();
  }

  async forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
}
