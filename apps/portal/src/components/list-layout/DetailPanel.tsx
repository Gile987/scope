// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DetailPanelProps {
  /** Title shown in the panel header. */
  title: ReactNode;
  /** Optional subtitle / metadata under the title. */
  subtitle?: ReactNode;
  /** Optional action slot in the header (e.g. tabs, buttons). */
  headerActions?: ReactNode;
  /** Called when the user clicks the close button. */
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Right-docked detail panel rendered inside a `ListLayout`. Not a modal — the
 * listing remains interactive on the left while the panel is visible.
 */
export function DetailPanel({
  title,
  subtitle,
  headerActions,
  onClose,
  children,
  className,
}: DetailPanelProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden bg-background animate-in slide-in-from-right-4 duration-200",
        className,
      )}
      role="complementary"
      aria-label="Detail panel"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
          </div>
          {subtitle && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close detail panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      {headerActions && (
        <div className="border-b border-border/60 px-4 py-2">{headerActions}</div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </div>
  );
}
