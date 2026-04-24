// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import type { RunStatus, RunOutcome } from "@/types";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "purple";

const statusConfig: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Pending", variant: "secondary" },
  queued: { label: "Queued", variant: "purple" },
  processing: { label: "Processing", variant: "info" },
  paused: { label: "Paused", variant: "warning" },
  done: { label: "Done", variant: "success" },
};

const outcomeConfig: Record<RunOutcome, { label: string; variant: BadgeVariant }> = {
  succeeded: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  finished: { label: "Finished", variant: "warning" },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome?: RunOutcome }) {
  if (!outcome) return <span className="text-xs text-muted-foreground">–</span>;
  const config = outcomeConfig[outcome] ?? { label: outcome, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
