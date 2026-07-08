// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from "react";
import { HelpCircle, ExternalLink } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { docsUrl, type DocsPage } from "@/lib/docs";

export interface HelpTooltipProps {
  /** Short explanation shown inside the tooltip. */
  text: React.ReactNode;
  /**
   * Optional documentation page key. When provided, the `?` icon becomes a
   * link that opens the docs page in a new tab and a "Learn more" affordance
   * is rendered inside the tooltip.
   */
  docs?: DocsPage;
  /** Override the link label when `docs` is set. Defaults to "Learn more". */
  linkLabel?: string;
  /** Accessible label for the trigger. Defaults to "More info". */
  ariaLabel?: string;
  /** Visual size of the icon. Defaults to "sm". */
  size?: "xs" | "sm" | "md";
  className?: string;
  /** Tooltip placement. Defaults to "top". */
  side?: "top" | "right" | "bottom" | "left";
}

const SIZE_CLASSES: Record<NonNullable<HelpTooltipProps["size"]>, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
};

/**
 * `?` icon that reveals a tooltip explaining a concept and (optionally) links
 * to the relevant documentation page. Designed for inline use next to labels,
 * card titles, and page headers.
 */
export function HelpTooltip({
  text,
  docs,
  linkLabel = "Learn more",
  ariaLabel,
  size = "sm",
  className,
  side = "top",
}: HelpTooltipProps) {
  const href = docs ? docsUrl(docs) : undefined;
  const label = ariaLabel ?? (href ? `${linkLabel} about this` : "More info");
  const iconClass = cn(SIZE_CLASSES[size], "text-muted-foreground");

  const triggerClass = cn(
    "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
    className,
  );

  const trigger = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={triggerClass}
      onClick={(e) => e.stopPropagation()}
    >
      <HelpCircle className={iconClass} aria-hidden="true" />
    </a>
  ) : (
    <button
      type="button"
      aria-label={label}
      className={triggerClass}
      onClick={(e) => e.preventDefault()}
    >
      <HelpCircle className={iconClass} aria-hidden="true" />
    </button>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed">
          <div className="space-y-1.5">
            <div>{text}</div>
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 hover:no-underline"
              >
                {linkLabel}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
