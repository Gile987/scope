// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Checks the telemetry feature flag via the Scope API.
 *
 * Returns `true` if telemetry should be enabled, `false` if explicitly disabled.
 * Defaults to `false` (disabled) on any failure (network error, timeout, API down,
 * flag not found) — telemetry is opt-in and must be explicitly enabled via the flag.
 *
 * @param apiUrl - Base URL of the Scope API (e.g. "http://api.scoped.svc.cluster.local:80")
 * @param timeoutMs - Maximum time to wait for the flag check (default: 2000ms)
 */
export async function checkTelemetryFlag(
  apiUrl: string | undefined,
  timeoutMs = 2000,
): Promise<boolean> {
  if (!apiUrl) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${apiUrl}/api/v1/feature-flags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return false;

    const flags = (await response.json()) as Array<{ key: string; enabled: boolean }>;
    const telemetryFlag = flags.find((f) => f.key === "telemetry");

    // If flag doesn't exist yet, default to disabled (opt-in)
    return telemetryFlag?.enabled ?? false;
  } catch {
    // Network error, timeout, API not ready — default to disabled
    return false;
  }
}

/**
 * Polls the telemetry feature flag at a configurable interval.
 * Exposes a synchronous `isEnabled` getter for use by the GatingSpanProcessor.
 */
export class TelemetryFlagPoller {
  private _enabled: boolean;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _apiUrl: string | undefined;
  private readonly _intervalMs: number;
  private readonly _timeoutMs: number;

  constructor(
    apiUrl: string | undefined,
    options?: { initialValue?: boolean; intervalMs?: number; timeoutMs?: number },
  ) {
    this._apiUrl = apiUrl;
    this._enabled = options?.initialValue ?? false;
    this._intervalMs = options?.intervalMs ?? 60_000;
    this._timeoutMs = options?.timeoutMs ?? 2_000;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Start periodic polling. Safe to call multiple times. */
  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.poll();
    }, this._intervalMs);
    // Don't keep the process alive just for flag polling
    this._timer.unref();
  }

  /** Stop polling. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Poll once and update the enabled state. */
  async poll(): Promise<boolean> {
    this._enabled = await checkTelemetryFlag(this._apiUrl, this._timeoutMs);
    return this._enabled;
  }
}
