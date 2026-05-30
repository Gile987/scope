// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Terminal, Copy, Check, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CliCommand as CliCommandValue } from "@/lib/cli/buildCommand";

export interface CliCommandProps {
  /** The command to display. Recompute in the parent so it tracks live state. */
  command: CliCommandValue;
  /** Optional label shown next to the terminal glyph (e.g. "CLI"). */
  label?: string;
  /** Popover heading. */
  title?: string;
  /** Tooltip on the trigger. */
  tooltip?: string;
  /** Popover alignment relative to the trigger. */
  align?: "start" | "center" | "end";
  className?: string;
}

/**
 * "Copy as CLI" affordance: a terminal-glyph button that reveals the exact
 * `scope` command equivalent to the user's current Portal state, with a copy
 * button and any parity caveats. See lib/cli/buildCommand.ts for the builders.
 */
export function CliCommand({
  command,
  label,
  title = "Run this from the CLI",
  tooltip = "Show CLI equivalent",
  align = "end",
  className,
}: CliCommandProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.command);
      setCopied(true);
      toast.success("CLI command copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  const trigger = label ? (
    <Button variant="outline" size="sm" className={cn("h-8 gap-1.5", className)} aria-label={tooltip}>
      <Terminal className="h-3.5 w-3.5" />
      <span className="text-xs font-medium">{label}</span>
    </Button>
  ) : (
    <Button variant="ghost" size="icon" className={cn("h-8 w-8 text-muted-foreground", className)} aria-label={tooltip}>
      <Terminal className="h-4 w-4" />
    </Button>
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align={align} className="w-[26rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">{title}</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <pre className="max-h-60 overflow-auto bg-muted/50 px-3 py-2.5 text-xs leading-relaxed">
          <code className="font-mono text-foreground">{command.display}</code>
        </pre>
        {command.notes.length > 0 && (
          <ul className="space-y-1.5 border-t px-3 py-2">
            {command.notes.map((note, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Not installed? <code className="font-mono">npm i -g @scope/cli</code>. Set{" "}
          <code className="font-mono">SCOPE_API_URL</code> or pass <code className="font-mono">-u &lt;url&gt;</code> if
          your API isn't local.
        </div>
      </PopoverContent>
    </Popover>
  );
}
