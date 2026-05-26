// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";

type PostProcessorStatus = "queued" | "processing" | "done" | "failed";

const STATUS_CONFIG: Record<string, { label: string; variant: "success" | "destructive" | "secondary" }> = {
  queued: { label: "Pending", variant: "secondary" },
  processing: { label: "Enriching…", variant: "secondary" },
  done: { label: "Enriched", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
};

const DEFAULT_CONFIG = { label: "Pending", variant: "secondary" as const };

interface EnrichmentBadgeProps {
  status?: PostProcessorStatus | string;
  version?: number;
}

export function EnrichmentBadge({ status, version }: EnrichmentBadgeProps) {
  const config = (status && STATUS_CONFIG[status]) || DEFAULT_CONFIG;

  return (
    <Badge
      variant={config.variant}
      title={version !== undefined ? `Enrichment v${version}` : undefined}
    >
      {config.label}
    </Badge>
  );
}
