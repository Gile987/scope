// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RunStatus } from "../types";

/**
 * Pure predicate driving the StatusBadge pulse animation. The badge pulses
 * only while a run is `processing` AND the most recent heartbeat is fresh
 * (within `staleAfterMs`, default 30s). If no heartbeat has been recorded
 * yet, the run is treated as fresh for up to `noHeartbeatGraceMs` (default
 * 60s) after `startedAt` — beyond that the worker is presumed dead and the
 * badge stops pulsing. This covers the case where the heartbeat key expires
 * from Redis after a worker dies. An unparseable timestamp is treated as
 * fresh to avoid silently masking a live run.
 */
export function shouldPulse(
  status: RunStatus,
  lastHeartbeatAt: string | Date | undefined | null,
  nowMs: number,
  startedAt?: string | Date | undefined | null,
  staleAfterMs = 30_000,
  noHeartbeatGraceMs = 60_000,
): boolean {
  if (status !== "processing") return false;
  if (lastHeartbeatAt === undefined || lastHeartbeatAt === null) {
    // No heartbeat data available — use startedAt as a fallback.
    // If the run started more than noHeartbeatGraceMs ago without any
    // heartbeat, the worker is presumed dead.
    if (startedAt === undefined || startedAt === null) return true;
    const startMs = new Date(startedAt).getTime();
    if (!Number.isFinite(startMs)) return true;
    return nowMs - startMs <= noHeartbeatGraceMs;
  }
  const heartbeatMs = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(heartbeatMs)) return true;
  return nowMs - heartbeatMs <= staleAfterMs;
}
