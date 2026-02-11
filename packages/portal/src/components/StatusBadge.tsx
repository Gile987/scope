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
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
