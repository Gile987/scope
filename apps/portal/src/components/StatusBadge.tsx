// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
  // Pulse the badge while a run is actively processing so it's visually
  // obvious the worker is still alive (vs. stuck "Processing" forever after
  // a crash). Default Tailwind animate-pulse oscillates opacity 100% / 50%,
  // which keeps the label readable.
  const className = status === "processing" ? "animate-pulse" : undefined;
  return <Badge variant={config.variant} className={cn(className)}>{config.label}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome?: RunOutcome }) {
  if (!outcome) return <span className="text-xs text-muted-foreground">–</span>;
  const config = outcomeConfig[outcome] ?? { label: outcome, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
