// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RunStatus, RunOutcome, RunState } from "@/types";

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

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function StatusBadge({
  status,
  worker,
  lastHeartbeatAt,
}: {
  status: RunStatus;
  worker?: RunState["worker"];
  lastHeartbeatAt?: RunState["lastHeartbeatAt"];
}) {
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };
  // Pulse the badge while a run is actively processing so it's visually
  // obvious the worker is still alive (vs. stuck "Processing" forever after
  // a crash). Default Tailwind animate-pulse oscillates opacity 100% / 50%,
  // which keeps the label readable.
  const className = status === "processing" ? "animate-pulse" : undefined;
  const badge = <Badge variant={config.variant} className={cn(className)}>{config.label}</Badge>;

  if (status !== "processing" || (!worker && !lastHeartbeatAt)) return badge;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so the tooltip works even when the badge has no
              focusable behavior of its own */}
          <span className="inline-flex">{badge}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-0.5 text-xs">
            {worker && (
              <>
                <div>
                  <span className="text-muted-foreground">Worker: </span>
                  <span className="font-mono">{worker.instanceId}</span>
                </div>
                {worker.podName && (
                  <div>
                    <span className="text-muted-foreground">Pod: </span>
                    <span className="font-mono">{worker.podName}</span>
                  </div>
                )}
              </>
            )}
            {lastHeartbeatAt && (
              <div>
                <span className="text-muted-foreground">Last heartbeat: </span>
                <span>{formatRelative(lastHeartbeatAt)}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function OutcomeBadge({ outcome }: { outcome?: RunOutcome }) {
  if (!outcome) return <span className="text-xs text-muted-foreground">–</span>;
  const config = outcomeConfig[outcome] ?? { label: outcome, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
