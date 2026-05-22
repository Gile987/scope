// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface BulkActionBarProps {
  /** Number of currently selected items. */
  count: number;
  /** Clear the selection. */
  onClear: () => void;
  /** Item label (e.g. "run", "report"). */
  itemLabel?: string;
  /** Action buttons rendered on the right side. */
  children?: ReactNode;
  className?: string;
}

/**
 * Sticky action bar displayed above the list when one or more rows are
 * selected. Renders nothing when `count === 0`.
 */
export function BulkActionBar({
  count,
  onClear,
  itemLabel = "item",
  children,
  className,
}: BulkActionBarProps) {
  if (count === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm",
        className,
      )}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="font-medium whitespace-nowrap">
        {count} {itemLabel}
        {count !== 1 ? "s" : ""} selected
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="h-4 w-4" />
      </Button>
      <div className="flex-1" />
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
