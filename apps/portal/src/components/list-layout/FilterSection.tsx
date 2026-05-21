// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode, useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FilterSectionProps {
  title: string;
  defaultOpen?: boolean;
  /** When provided, persists open/closed state to localStorage under this key. */
  storageKey?: string;
  children: ReactNode;
  className?: string;
}

export function FilterSection({
  title,
  defaultOpen = true,
  storageKey,
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

  useEffect(() => {
    if (!fullKey) return;
    try {
      localStorage.setItem(fullKey, open ? "1" : "0");
    } catch { /* ignore */ }
  }, [fullKey, open]);

  return (
    <div className={cn("border-b border-border/60 last:border-b-0", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>{title}</span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-1.5">{children}</div>}
    </div>
  );
}
