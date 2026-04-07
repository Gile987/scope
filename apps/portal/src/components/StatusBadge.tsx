// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import type { RunStatus, RunOutcome } from "@/types";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info";

const statusConfig: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Pending", variant: "secondary" },
  processing: { label: "Processing", variant: "info" },
  done: { label: "Done", variant: "success" },
};

const outcomeConfig: Record<RunOutcome, { label: string; variant: BadgeVariant }> = {
  succeeded: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  exhausted: { label: "Exhausted", variant: "warning" },
};

export function StatusBadge({ status, outcome }: { status: RunStatus; outcome?: RunOutcome }) {
  // When done, show the outcome badge instead of generic "Done"
  if (status === "done" && outcome) {
    const config = outcomeConfig[outcome] ?? { label: outcome, variant: "outline" as const };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  }
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
