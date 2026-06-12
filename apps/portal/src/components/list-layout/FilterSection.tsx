// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FilterSectionProps {
  title: string;
  defaultOpen?: boolean;
  /** When provided, persists open/closed state to localStorage under this key. */
  storageKey?: string;
  /** When provided, allows section to be dragged/reordered. */
  sortableId?: string;
  children: ReactNode;
  className?: string;
}

export function FilterSection({
  title,
  defaultOpen = true,
  storageKey,
  sortableId,
  children,
  className,
}: FilterSectionProps) {
  const fullKey = storageKey ? `scope:filter-section:${storageKey}` : null;
  const [open, setOpen] = useState<boolean>(() => {
    if (!fullKey) return defaultOpen;
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch { /* ignore */ }
    return defaultOpen;
  });

  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!fullKey) return;
    try {
      localStorage.setItem(fullKey, open ? "1" : "0");
    } catch { /* ignore */ }
  }, [fullKey, open]);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!sortableId) return;
    setIsDragging(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sortableId);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  return (
    <div 
      className={cn("border-b border-border/60 last:border-b-0 transition-opacity", sortableId && isDragging && "opacity-50", className)}
      draggable={!!sortableId}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors group"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {sortableId && (
            <GripVertical className="h-3.5 w-3.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing" />
          )}
          <span>{title}</span>
        </div>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
        )}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-1.5">{children}</div>}
    </div>
  );
}
