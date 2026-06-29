// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatId } from "@/lib/utils";

interface ShortIdProps {
  /** The full identifier. The trigger renders a truncated form of this. */
  id: string;
  /**
   * Number of leading characters shown in the trigger. Defaults to the
   * project-wide convention of 8 (via {@link formatId}).
   */
  length?: number;
  /** Class applied to the trigger `<span>`. */
  className?: string;
  /** Human label used in aria/title text, e.g. "run ID". Defaults to "ID". */
  label?: string;
}

/**
 * Inline short-id with a hover tooltip that reveals the **full** identifier and
 * a copy-to-clipboard button.
 *
 * The trigger stays an inline `<span>` (not a button) so it does not interfere
 * with an ancestor row click (e.g. navigating to the run). The copy button
 * lives inside the tooltip content, which Radix keeps hoverable by default, so
 * it is reachable and clickable. The copy handler stops propagation so the row
 * click does not fire when copying.
 */
export function ShortId({ id, length, className, label = "ID" }: ShortIdProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const short = length != null ? id.slice(0, length) : formatId(id);

  const copy = async (e: React.MouseEvent) => {
    // Keep the click from bubbling to an ancestor row onClick (navigation).
    e.stopPropagation();
    e.preventDefault();
    // Clipboard is unavailable in non-secure contexts / some test envs.
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Swallow — copying is best-effort and must never break the row.
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span className={cn("font-mono text-xs", className)}>{short}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex items-center gap-2">
          <code className="select-all font-mono text-xs">{id}</code>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
            title={copied ? "Copied" : "Copy"}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
