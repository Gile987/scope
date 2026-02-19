// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import type { ReportStatus } from "@/types";

const statusConfig: Record<ReportStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" }> = {
  pending: { label: "Pending", variant: "secondary" },
  generating: { label: "Generating", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
};

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
