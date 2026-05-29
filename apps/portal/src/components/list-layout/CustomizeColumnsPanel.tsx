// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface CustomizeColumnsOption {
  /** Stable column id (matches DataTableColumn.id). */
  id: string;
  /** Human-readable label shown in the panel. */
  label: string;
  /**
   * When true, the column cannot be hidden (e.g. the primary identifier).
   * Required columns are also locked from reordering when DnD is enabled.
   */
  required?: boolean;
}

export interface CustomizeColumnsPanelProps {
  /** All toggleable columns, in their natural order. */
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

  /**
   * Optional persisted column order. When both `order` and `onReorder` are
   * provided, the list renders in the given order and each non-required
   * column shows a drag handle. Required columns stay locked at their
   * natural index.
   */
  order?: readonly string[];
  /** Commit a new order — non-required ids only; required ones are merged back. */
  onReorder?: (next: string[]) => void;
}

/** Compute the rendered order respecting required-column locks. */
function buildDisplayOrder(
  columns: readonly CustomizeColumnsOption[],
  order: readonly string[] | undefined,
): CustomizeColumnsOption[] {
  if (!order) return [...columns];
  const byId = new Map(columns.map((c) => [c.id, c]));
  const required = columns.filter((c) => c.required);
  const requiredIds = new Set(required.map((c) => c.id));

  // 1. Start from user-supplied order, filtered to non-required known ids.
  const userOrdered = order
    .map((id) => byId.get(id))
    .filter((c): c is CustomizeColumnsOption => !!c && !requiredIds.has(c.id));

  // 2. Append any toggleable columns missing from `order` (defensive — should
  // not happen after `useColumnOrder` reconciles, but guards against bad input).
  for (const c of columns) {
    if (c.required) continue;
    if (!userOrdered.some((x) => x.id === c.id)) userOrdered.push(c);
  }

  // 3. Splice required columns back at their natural index.
  const result: CustomizeColumnsOption[] = [...userOrdered];
  for (const req of required) {
    const naturalIndex = columns.indexOf(req);
    result.splice(Math.min(naturalIndex, result.length), 0, req);
  }
  return result;
}

/**
 * Slide-in panel for customizing which DataTable columns are visible (and,
 * when DnD is enabled, in what order they appear).
 *
 * Toggles apply live; reorders are committed on drop. Required columns are
 * locked from reordering and their checkbox is disabled.
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
  order,
  onReorder,
}: CustomizeColumnsPanelProps) {
  const reorderEnabled = !!order && !!onReorder;
  const displayedColumns = buildDisplayOrder(columns, reorderEnabled ? order : undefined);

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

  // Drag state. `draggingId` is the id being dragged; `dropTargetId` is the
  // id whose row currently shows the insertion indicator. `dropAtEnd` is true
  // when the indicator should render below the last row.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropAtEnd, setDropAtEnd] = useState(false);

  const clearDragState = () => {
    setDraggingId(null);
    setDropTargetId(null);
    setDropAtEnd(false);
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOverRow = (e: React.DragEvent, targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetId(targetId);
    setDropAtEnd(false);
  };

  const handleDragOverEndZone = (e: React.DragEvent) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetId(null);
    setDropAtEnd(true);
  };

  const commitDrop = (targetId: string | null, atEnd: boolean) => {
    if (!draggingId || !reorderEnabled) {
      clearDragState();
      return;
    }
    // Build the next non-required order from the currently displayed columns.
    const nonRequiredOrder = displayedColumns.filter((c) => !c.required).map((c) => c.id);
    const fromIndex = nonRequiredOrder.indexOf(draggingId);
    if (fromIndex < 0) {
      clearDragState();
      return;
    }
    nonRequiredOrder.splice(fromIndex, 1);
    let toIndex: number;
    if (atEnd) {
      toIndex = nonRequiredOrder.length;
    } else if (targetId == null) {
      toIndex = nonRequiredOrder.length;
    } else {
      const idx = nonRequiredOrder.indexOf(targetId);
      toIndex = idx < 0 ? nonRequiredOrder.length : idx;
    }
    nonRequiredOrder.splice(toIndex, 0, draggingId);
    onReorder?.(nonRequiredOrder);
    clearDragState();
  };

  const handleDropOnRow = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    commitDrop(targetId, false);
  };

  const handleDropOnEndZone = (e: React.DragEvent) => {
    e.preventDefault();
    commitDrop(null, true);
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

        <ul className="space-y-0.5" onDragEnd={clearDragState}>
          {displayedColumns.map((col) => {
            const visible = !hidden.has(col.id);
            const draggable = reorderEnabled && !col.required;
            const isDragging = draggingId === col.id;
            const showIndicator = reorderEnabled && dropTargetId === col.id && !dropAtEnd;
            return (
              <li
                key={col.id}
                onDragOver={draggable ? (e) => handleDragOverRow(e, col.id) : undefined}
                onDrop={draggable ? (e) => handleDropOnRow(e, col.id) : undefined}
                className={cn(
                  "rounded transition-colors",
                  showIndicator && "border-t-2 border-primary",
                  isDragging && "opacity-50",
                )}
              >
                <label
                  className={cn(
                    "flex items-center gap-1 rounded px-1.5 py-1.5 text-sm",
                    col.required
                      ? "cursor-not-allowed"
                      : "cursor-pointer hover:bg-accent/50",
                  )}
                >
                  {reorderEnabled && (
                    <span
                      draggable={draggable}
                      onDragStart={draggable ? (e) => handleDragStart(e, col.id) : undefined}
                      className={cn(
                        "flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground",
                        draggable ? "cursor-grab active:cursor-grabbing" : "opacity-30",
                      )}
                      aria-label={draggable ? `Drag to reorder ${col.label}` : `${col.label} is locked`}
                      title={draggable ? "Drag to reorder" : "Locked"}
                    >
                      <GripVertical className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  )}
                  <Checkbox
                    checked={visible}
                    disabled={col.required}
                    onCheckedChange={() => onToggle(col.id)}
                    aria-label={visible ? `Hide ${col.label}` : `Show ${col.label}`}
                  />
                  <span className={cn(col.required && "opacity-60")}>{col.label}</span>
                </label>
              </li>
            );
          })}

          {reorderEnabled && (
            <li
              onDragOver={handleDragOverEndZone}
              onDrop={handleDropOnEndZone}
              className={cn(
                "h-2 rounded transition-colors",
                dropAtEnd && "border-t-2 border-primary",
              )}
              aria-hidden
            />
          )}
        </ul>
      </div>

      <footer className="flex items-center justify-start gap-2 border-t border-border/60 px-3 py-2.5 text-sm">
        <button
          type="button"
          onClick={onReset}
          className="text-primary transition-colors hover:text-primary/80"
        >
          Restore
        </button>
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
