// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RunStatus } from "../types";

/**
 * Pure predicate driving the StatusBadge pulse animation. The badge pulses
 * only while a run is `processing` AND the most recent heartbeat is fresh
 * (within `staleAfterMs`, default 30s). If no heartbeat has been recorded
 * yet, the run is treated as fresh so the pulse still appears at startup
 * before the first worker tick lands. An unparseable timestamp is also
 * treated as fresh to avoid silently masking a live run.
 */
export function shouldPulse(
  status: RunStatus,
  lastHeartbeatAt: string | Date | undefined | null,
  nowMs: number,
  staleAfterMs = 30_000,
): boolean {
  if (status !== "processing") return false;
  if (lastHeartbeatAt === undefined || lastHeartbeatAt === null) return true;
  const heartbeatMs = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(heartbeatMs)) return true;
  return nowMs - heartbeatMs <= staleAfterMs;
}
