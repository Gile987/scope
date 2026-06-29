// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { promptTypeLabel } from "@/lib/gates";
import { cn, formatDate, formatId, truncate } from "@/lib/utils";
import type { TaskPrompt } from "@/types";

const SNIPPET_LEN = 280;

interface TaskPromptBadgeProps {
  /** Content-addressed task prompt id (used for the link target and lazy fetch). */
  taskPromptId?: string | null;
  /**
   * Preloaded prompt to render the hover preview without a network round-trip.
   * When omitted, the prompt is fetched lazily the first time the tooltip opens.
   */
  prompt?: TaskPrompt;
  /** Custom trigger content. Defaults to a `<type label> · <short id>` badge. */
  children?: ReactNode;
  /** When true (default) the trigger links to the task prompt detail page. */
  link?: boolean;
  /** Class applied to the trigger wrapper (Link/span). */
  className?: string;
}

/**
 * Hover-to-preview + click-to-navigate badge for a task prompt of **any** type.
 *
 * The component is intentionally type-agnostic: gate prompts
 * (`select`/`build`/`test`/`run`/`deploy`), `agents.md`, and legacy untyped
 * prompts all render with the same hover preview and the same
 * `/task-prompts/:id` navigation. The only type-dependent bit is the human
 * label, which comes from {@link promptTypeLabel}.
 *
 * To avoid request fan-out on dense screens, the prompt is only fetched when
 * the tooltip actually opens (and never when a preloaded `prompt` is supplied).
 */
export function TaskPromptBadge({
  taskPromptId,
  prompt,
  children,
  link = true,
  className,
}: TaskPromptBadgeProps) {
  const [open, setOpen] = useState(false);

  const { data: fetched, isLoading: loadingPrompt } = useQuery({
    queryKey: ["task-prompt", taskPromptId],
    queryFn: () => api.getTaskPrompt(taskPromptId as string),
    enabled: open && !prompt && !!taskPromptId,
    staleTime: 5 * 60 * 1000,
  });

  const resolved = prompt ?? fetched;

  // Blob-backed prompts omit `text`; fetch the body for the snippet on open.
  const needsContent = open && !!resolved && resolved.text === undefined && !!taskPromptId;
  const { data: content } = useQuery({
    queryKey: ["task-prompt-content", taskPromptId],
    queryFn: () => api.getTaskPromptContent(taskPromptId as string),
    enabled: needsContent,
    staleTime: 5 * 60 * 1000,
  });

  const typeLabel = promptTypeLabel(resolved?.type);
  const snippet = resolved?.text ?? content?.text;
  const detected = resolved?.features?.filter((f) => f.detected).length ?? 0;
  const total = resolved?.features?.length ?? 0;

  // Without an id there is nothing to preview or link to — render content plainly.
  if (!taskPromptId) {
    return children ? (
      <span className={cn("inline-flex max-w-full", className)}>{children}</span>
    ) : null;
  }

  const trigger = children ?? (
    <Badge variant="secondary" className="font-mono text-xs">
      {typeLabel} · {formatId(taskPromptId)}
    </Badge>
  );

  const wrapper = link ? (
    <Link
      to={`/task-prompts/${encodeURIComponent(taskPromptId)}`}
      className={cn("inline-flex max-w-full", className)}
      onClick={(e) => e.stopPropagation()}
    >
      {trigger}
    </Link>
  ) : (
    <span className={cn("inline-flex max-w-full", className)}>{trigger}</span>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{wrapper}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">{typeLabel}</span>
              <span className="font-mono text-muted-foreground">{formatId(taskPromptId)}</span>
            </div>
            {loadingPrompt && !resolved ? (
              <Skeleton className="h-10 w-52" />
            ) : (
              <>
                {snippet !== undefined ? (
                  <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words text-muted-foreground">
                    {truncate(snippet, SNIPPET_LEN)}
                  </p>
                ) : resolved?.text === undefined ? (
                  <p className="italic text-muted-foreground">Open to view the full body.</p>
                ) : null}
                {total > 0 && (
                  <div className="text-muted-foreground">
                    Features: {detected}/{total} detected
                  </div>
                )}
                {resolved?.createdAt && (
                  <div className="text-muted-foreground">Created {formatDate(resolved.createdAt)}</div>
                )}
              </>
            )}
            {link && <div className="text-muted-foreground">Click to open details →</div>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
