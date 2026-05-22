// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode, type Key } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SortDir } from "./useListUrlState";

export interface DataTableColumn<T> {
  /** Stable column id, used as the sort key. */
  id: string;
  /** Header cell content. */
  header: ReactNode;
  /** Body cell renderer. */
  cell: (item: T) => ReactNode;
  /** When true, the header becomes clickable for sorting. */
  sortable?: boolean;
  /** Optional column width (e.g. "120px", "20%"). */
  width?: string;
  /** Right-align cell content. */
  align?: "left" | "right" | "center";
  /** Render only when truthy (used by visibility menus). */
  hidden?: boolean;
  /** Extra class for cells in this column. */
  className?: string;
}

export interface DataTableSelection<T> {
  /** Currently selected row ids. */
  selectedIds: ReadonlySet<Key>;
  /** Toggle a single row's selection. */
  onToggle: (id: Key, item: T) => void;
  /** Toggle every currently rendered row at once. */
  onToggleAll: (allIds: Key[], allItems: readonly T[]) => void;
  /** Optional predicate to disable selection for specific rows. */
  isDisabled?: (item: T) => boolean;
}

export interface DataTableProps<T> {
  items: readonly T[];
  columns: readonly DataTableColumn<T>[];
  /** Unique row identifier — used for `key` and active-row highlighting. */
  getRowId: (item: T) => Key;
  /** Optional active row id (highlighted as selected). */
  activeId?: Key | null;
  /** Called when a row body cell is clicked. */
  onRowClick?: (item: T) => void;
  /** Multi-selection support — renders a leading checkbox column. */
  selection?: DataTableSelection<T>;
  /** Current sort column. */
  sort?: string | null;
  sortDir?: SortDir;
  /** Toggle sort handler. */
  onSortChange?: (column: string) => void;
  /** True while initial data is loading — shows skeleton rows. */
  loading?: boolean;
  /** Number of skeleton rows. */
  loadingRows?: number;
  /** Rendered when items is empty and loading is false. */
  emptyState?: ReactNode;
  /** Row density. */
  density?: "comfortable" | "compact";
  className?: string;
}

export function DataTable<T>({
  items,
  columns,
  getRowId,
  activeId,
  onRowClick,
  selection,
  sort,
  sortDir = "asc",
  onSortChange,
  loading,
  loadingRows = 5,
  emptyState,
  density = "comfortable",
  className,
}: DataTableProps<T>) {
  const visibleColumns = columns.filter((c) => !c.hidden);
  const rowPadY = density === "compact" ? "py-1.5" : "py-3";

  const selectableItems = selection
    ? items.filter((it) => !(selection.isDisabled?.(it) ?? false))
    : [];
  const selectableIds = selectableItems.map((it) => getRowId(it));
  const selectedVisibleCount = selectableIds.filter((id) => selection?.selectedIds.has(id)).length;
  const allVisibleSelected =
    selectableIds.length > 0 && selectedVisibleCount === selectableIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  const colSpan = visibleColumns.length + (selection ? 1 : 0);

  return (
    <div className={cn("rounded-md border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {selection && (
              <TableHead style={{ width: "40px" }} className="text-center">
                <Checkbox
                  checked={
                    allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                  }
                  disabled={selectableIds.length === 0}
                  onCheckedChange={() => selection.onToggleAll(selectableIds, selectableItems)}
                  aria-label={allVisibleSelected ? "Deselect all" : "Select all"}
                />
              </TableHead>
            )}
            {visibleColumns.map((col) => {
              const isActiveSort = sort === col.id;
              const alignClass =
                col.align === "right"
                  ? "text-right"
                  : col.align === "center"
                    ? "text-center"
                    : "text-left";
              return (
                <TableHead
                  key={col.id}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(alignClass, col.className)}
                >
                  {col.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(col.id)}
                      className={cn(
                        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
                        isActiveSort ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span>{col.header}</span>
                      {isActiveSort ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }).map((_, i) => (
              <TableRow key={`skeleton-${i}`}>
                {selection && (
                  <TableCell className={rowPadY}>
                    <Skeleton className="h-4 w-4" />
                  </TableCell>
                )}
                {visibleColumns.map((col) => (
                  <TableCell key={col.id} className={rowPadY}>
                    <Skeleton className="h-4 w-full max-w-[140px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={colSpan} className="h-32 text-center text-muted-foreground">
                {emptyState ?? "No results"}
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const rowId = getRowId(item);
              const isActive = activeId !== undefined && activeId !== null && rowId === activeId;
              const isSelected = selection?.selectedIds.has(rowId) ?? false;
              const isSelectionDisabled = selection?.isDisabled?.(item) ?? false;
              return (
                <TableRow
                  key={rowId}
                  data-active={isActive ? "true" : undefined}
                  data-selected={isSelected ? "true" : undefined}
                  className={cn(
                    onRowClick && "cursor-pointer",
                    isActive && "bg-accent/60 hover:bg-accent",
                    isSelected && !isActive && "bg-primary/5 hover:bg-primary/10",
                  )}
                  onClick={onRowClick ? () => onRowClick(item) : undefined}
                >
                  {selection && (
                    <TableCell
                      className={cn(rowPadY, "text-center")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={isSelected}
                        disabled={isSelectionDisabled}
                        onCheckedChange={() => selection.onToggle(rowId, item)}
                        aria-label={isSelected ? "Deselect row" : "Select row"}
                      />
                    </TableCell>
                  )}
                  {visibleColumns.map((col) => {
                    const alignClass =
                      col.align === "right"
                        ? "text-right"
                        : col.align === "center"
                          ? "text-center"
                          : "";
                    return (
                      <TableCell
                        key={col.id}
                        className={cn(rowPadY, alignClass, col.className)}
                      >
                        {col.cell(item)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
