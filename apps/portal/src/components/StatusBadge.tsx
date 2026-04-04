// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "@/types";

const statusConfig: Record<RunStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" }> = {
  pending: { label: "Pending", variant: "secondary" },
  processing: { label: "Processing", variant: "info" },
  iterating: { label: "Iterating", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  exhausted: { label: "Exhausted", variant: "warning" },
  interrupted: { label: "Interrupted", variant: "destructive" },
};

/** Heartbeat is considered fresh if it arrived less than 60 seconds ago. */
const HEARTBEAT_FRESH_MS = 60_000;

export function StatusBadge({ status, heartbeatAt }: { status: RunStatus; heartbeatAt?: string }) {
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };

  // Show pulsing indicator when the worker is actively processing (fresh heartbeat)
  const isActive =
    (status === "processing" || status === "iterating") &&
    heartbeatAt &&
    Date.now() - new Date(heartbeatAt).getTime() < HEARTBEAT_FRESH_MS;

  return (
    <Badge variant={config.variant}>
      {isActive && (
        <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
      )}
      {config.label}
    </Badge>
  );
}
