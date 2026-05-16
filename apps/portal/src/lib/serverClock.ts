// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Tracks the offset between the API server's clock and the local browser
 * clock so we can render relative timestamps (e.g. "5s ago") that are
 * resilient to a misconfigured local clock.
 *
 * Every HTTP response from the API carries a standard `Date` header with
 * the server's wall-clock time. We sample it on each request and store
 * `skewMs = serverNow - clientNow`. Callers can then use {@link serverNow}
 * as a drop-in replacement for `Date.now()` whenever they need to compare
 * a server-issued timestamp against the present moment.
 *
 * Resolution is one second (the granularity of the HTTP `Date` header),
 * which is well below what the UI displays.
 */

let skewMs = 0;

export function recordServerDate(headerValue: string | null | undefined): void {
  if (!headerValue) return;
  const serverMs = Date.parse(headerValue);
  if (!Number.isFinite(serverMs)) return;
  skewMs = serverMs - Date.now();
}

/** Current wall-clock time as estimated on the API server. */
export function serverNow(): number {
  return Date.now() + skewMs;
}

/** Currently-tracked offset (server - client) in ms. Mostly useful for tests/diagnostics. */
export function getServerSkewMs(): number {
  return skewMs;
}

/** Reset skew to zero. Only intended for use in tests. */
export function _resetSkewForTesting(): void {
  skewMs = 0;
}
