// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from "react";
import { Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AdvancedSectionProps {
  /** When false the section (and its children) render nothing. */
  show: boolean;
  /** Caption shown above the advanced fields. Defaults to "Advanced". */
  label?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Inline container for power-user fields gated behind the global advanced
 * toggle (see {@link useAdvancedMode}). Renders a subtle divider and a small
 * uppercase caption, then the fields — keeping the treatment identical across
 * every card on the Submit Run form.
 */
export function AdvancedSection({
  show,
  label = "Advanced",
  className,
  children,
}: AdvancedSectionProps) {
  if (!show) return null;

  return (
    <div className={cn("border-t border-border/60 pt-3.5", className)}>
      <div className="mb-2.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Settings2 className="h-3 w-3" aria-hidden="true" />
        {label}
      </div>
      {children}
    </div>
  );
}
