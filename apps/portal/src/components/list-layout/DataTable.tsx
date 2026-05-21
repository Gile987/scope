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

export interface DataTableProps<T> {
  items: readonly T[];
  columns: readonly DataTableColumn<T>[];
  /** Unique row identifier — used for `key` and active-row highlighting. */
  getRowId: (item: T) => Key;
  /** Optional active row id (highlighted as selected). */
  activeId?: Key | null;
  /** Called when a row body cell is clicked. */
  onRowClick?: (item: T) => void;
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

  return (
    <div className={cn("rounded-md border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
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
                {visibleColumns.map((col) => (
                  <TableCell key={col.id} className={rowPadY}>
                    <Skeleton className="h-4 w-full max-w-[140px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={visibleColumns.length}
                className="h-32 text-center text-muted-foreground"
              >
                {emptyState ?? "No results"}
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const rowId = getRowId(item);
              const isActive = activeId !== undefined && activeId !== null && rowId === activeId;
              return (
                <TableRow
                  key={rowId}
                  data-active={isActive ? "true" : undefined}
                  className={cn(
                    onRowClick && "cursor-pointer",
                    isActive && "bg-accent/60 hover:bg-accent",
                  )}
                  onClick={onRowClick ? () => onRowClick(item) : undefined}
                >
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
