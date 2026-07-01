// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { criterionResultStyle, type CriterionResultState } from "@/lib/criteria-result";

const PROMPT_LEN = 320;

interface CriteriaBadgeProps {
  criterionId: string;
  result?: CriterionResultState;
  evaluated?: boolean;
  link?: boolean;
  showStateLabel?: boolean;
  className?: string;
  /**
   * Preloaded criterion prompt for the hover preview. When omitted, the prompt
   * is fetched lazily the first time the tooltip opens (so dense lists don't
   * fan out one request per badge).
   */
  prompt?: string;
}

export function CriteriaBadge({
  criterionId,
  result,
  evaluated = false,
  link = true,
  showStateLabel = false,
  className,
  prompt,
}: CriteriaBadgeProps) {
  const [open, setOpen] = useState(false);

  const { data: fetched, isLoading } = useQuery({
    queryKey: ["criterion", criterionId],
    queryFn: () => api.getCriterion(criterionId),
    enabled: open && prompt === undefined,
    staleTime: 5 * 60 * 1000,
  });

  const promptText = prompt ?? fetched?.prompt;

  const content = !evaluated ? (
    <Badge variant="secondary" className={cn("font-mono text-xs", className)}>
      {criterionId}
    </Badge>
  ) : (() => {
    const { colorClass, Icon, label } = criterionResultStyle(result);
    return (
      <Badge variant="outline" className={cn("font-mono text-xs", colorClass, className)}>
        <Icon className="h-3 w-3 shrink-0 mr-1" />
        {showStateLabel ? `${criterionId}: ${label}` : criterionId}
      </Badge>
    );
  })();

  const trigger = link ? (
    <Link
      to={`/criteria/${criterionId}`}
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </Link>
  ) : (
    <span className="inline-flex">{content}</span>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <div className="space-y-1.5 text-xs">
            <div className="font-mono font-medium">{criterionId}</div>
            {isLoading && promptText === undefined ? (
              <Skeleton className="h-10 w-52" />
            ) : promptText !== undefined ? (
              <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words text-muted-foreground">
                {promptText.length > PROMPT_LEN ? `${promptText.slice(0, PROMPT_LEN)}…` : promptText}
              </p>
            ) : null}
            <div className="text-muted-foreground">
              {link ? "Click to open details →" : "Open the criterion detail page for more."}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
