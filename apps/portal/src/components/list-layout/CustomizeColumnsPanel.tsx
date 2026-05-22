// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface CustomizeColumnsOption {
  /** Stable column id (matches DataTableColumn.id). */
  id: string;
  /** Human-readable label shown in the panel. */
  label: string;
  /** When true, the column cannot be hidden (e.g. the primary identifier). */
  required?: boolean;
}

export interface CustomizeColumnsPanelProps {
  /** All toggleable columns, in the order they appear in the table. */
  columns: readonly CustomizeColumnsOption[];
  /** Currently hidden column ids. */
  hidden: ReadonlySet<string>;
  /** Toggle a single column's visibility — applied immediately. */
  onToggle: (id: string) => void;
  /**
   * Commit a new hidden set in one shot (used by the top-level "All" checkbox
   * which toggles many columns at once).
   */
  onSetHidden: (hidden: ReadonlySet<string>) => void;
  /** Reset to defaults handler — wired to the Restore link. */
  onReset: () => void;
  /** Close the panel. */
  onClose: () => void;
  /** Panel width (default 260px). */
  width?: string;
  className?: string;
}

/**
 * Slide-in panel for customizing which DataTable columns are visible.
 *
 * Designed to render as a third column inside `ListLayout` (between the filter
 * rail and the main listing) — the parent controls visibility by passing the
 * panel to `ListLayout.secondaryPanel`.
 *
 * Toggles apply live: every checkbox change calls back to the parent so the
 * underlying table updates immediately. **Restore** resets to defaults and
 * **Done** simply closes the panel.
 */
export function CustomizeColumnsPanel({
  columns,
  hidden,
  onToggle,
  onSetHidden,
  onReset,
  onClose,
  width = "260px",
  className,
}: CustomizeColumnsPanelProps) {
  const toggleable = columns.filter((c) => !c.required);
  const allVisible = toggleable.every((c) => !hidden.has(c.id));
  const someVisible = toggleable.some((c) => !hidden.has(c.id)) && !allVisible;

  const handleToggleAll = () => {
    const next = new Set(hidden);
    if (allVisible) {
      for (const c of toggleable) next.add(c.id);
    } else {
      for (const c of toggleable) next.delete(c.id);
    }
    onSetHidden(next);
  };

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-r border-border/60 bg-card/40 animate-in slide-in-from-left-4 duration-200",
        className,
      )}
      style={{ width }}
      aria-label="Customize columns"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3">
        <h2 className="text-sm font-semibold">Customize Columns</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close customize columns"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        <label className="flex items-center gap-2 rounded px-1.5 py-1.5 text-sm hover:bg-accent/50 cursor-pointer">
          <Checkbox
            checked={allVisible ? true : someVisible ? "indeterminate" : false}
            onCheckedChange={handleToggleAll}
            aria-label={allVisible ? "Hide all columns" : "Show all columns"}
          />
          <span className="font-medium">All</span>
        </label>

        <div className="my-1 h-px bg-border/60" />

        <ul className="space-y-0.5">
          {columns.map((col) => {
            const visible = !hidden.has(col.id);
            return (
              <li key={col.id}>
                <label
                  className={cn(
                    "flex items-center gap-2 rounded px-1.5 py-1.5 text-sm",
                    col.required
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer hover:bg-accent/50",
                  )}
                >
                  <Checkbox
                    checked={visible}
                    disabled={col.required}
                    onCheckedChange={() => onToggle(col.id)}
                    aria-label={visible ? `Hide ${col.label}` : `Show ${col.label}`}
                  />
                  <span>{col.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2.5 text-sm">
        <button
          type="button"
          onClick={onReset}
          className="text-primary transition-colors hover:text-primary/80"
        >
          Restore
        </button>
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </footer>
    </aside>
  );
}

export interface CustomizeColumnsLinkProps {
  onClick: () => void;
  label?: string;
}

/** Footer link rendered inside the FilterRail to open the customize panel. */
export function CustomizeColumnsLink({
  onClick,
  label = "Customize Columns",
}: CustomizeColumnsLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-primary transition-colors hover:text-primary/80"
    >
      {label}
    </button>
  );
}
