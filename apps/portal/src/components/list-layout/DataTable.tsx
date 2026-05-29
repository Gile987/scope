// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Fragment, type ReactNode, type Key, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
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
  /**
   * When the table renders as cards (mobile/tablet), this column is hidden
   * from the metadata grid. Useful for primary-key columns whose value is
   * already shown as the card title.
   */
  hiddenOnCard?: boolean;
  /**
   * Override the label shown in card view. Defaults to `header` if it's a
   * string, otherwise the column id.
   */
  cardLabel?: ReactNode;
  /**
   * Sticky placement for this column on desktop tables.
   * Useful for keeping key identifiers or action columns visible while scrolling.
   */
  sticky?: "left" | "right";
  /**
   * CSS offset for sticky columns (e.g. "40px" when selection column is present).
   */
  stickyOffset?: string;
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

export interface DataTableGrouping<T> {
  getGroupKey: (item: T) => string;
  renderGroupHeader: (groupKey: string, items: readonly T[], expanded: boolean) => ReactNode;
  /**
   * Optional per-column renderer for the group row. When provided, the group
   * row is rendered as a normal row using the table's columns (sticky/width/
   * alignment preserved) instead of a single full-width `colSpan` cell.
   * Return `null` or `undefined` to leave a column blank in the group row.
   * The provided `renderGroupHeader` is ignored when this is set.
   */
  renderGroupCell?: (
    column: DataTableColumn<T>,
    items: readonly T[],
    expanded: boolean,
  ) => ReactNode;
  expandedGroupKeys: ReadonlySet<string>;
  onToggleGroup: (groupKey: string) => void;
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
  /** Optional inline grouping rendered inside the same table/card list. */
  grouping?: DataTableGrouping<T>;
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
  grouping,
  sort,
  sortDir = "asc",
  onSortChange,
  loading,
  loadingRows = 5,
  emptyState,
  density = "comfortable",
  className,
}: DataTableProps<T>) {
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateTableScrollIndicators = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const hasOverflow = el.scrollWidth - el.clientWidth > 1;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setCanScrollLeft(hasOverflow && left);
    setCanScrollRight(hasOverflow && right);
  }, []);

  const visibleColumns = columns.filter((c) => !c.hidden);
  const rowPadY = density === "compact" ? "py-1.5" : "py-3";
  const groupedSections = grouping
    ? items.reduce<Array<{ key: string; items: T[] }>>((sections, item) => {
        const key = grouping.getGroupKey(item);
        const current = sections[sections.length - 1];
        if (current?.key === key) current.items.push(item);
        else sections.push({ key, items: [item] });
        return sections;
      }, [])
    : [];
  const visibleItems = grouping
    ? groupedSections.flatMap((section) =>
        grouping.expandedGroupKeys.has(section.key) ? section.items : [],
      )
    : items;

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;

    updateTableScrollIndicators();
    const onScroll = () => updateTableScrollIndicators();
    el.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTableScrollIndicators());
    resizeObserver.observe(el);
    const tableElement = el.querySelector("table");
    if (tableElement) resizeObserver.observe(tableElement);

    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTableScrollIndicators, visibleColumns.length, items.length, selection]);

  const selectableItems = selection
    ? visibleItems.filter((it) => !(selection.isDisabled?.(it) ?? false))
    : [];
  const selectableIds = selectableItems.map((it) => getRowId(it));
  const selectedVisibleCount = selectableIds.filter((id) => selection?.selectedIds.has(id)).length;
  const allVisibleSelected =
    selectableIds.length > 0 && selectedVisibleCount === selectableIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  const colSpan = visibleColumns.length + (selection ? 1 : 0);

  // First non-hidden, non-hiddenOnCard column is the card title.
  const cardColumns = visibleColumns.filter((c) => !c.hiddenOnCard);
  const primaryColumn = cardColumns[0];
  const metaColumns = cardColumns.slice(1);

  const renderDataRow = (item: T) => {
    const rowId = getRowId(item);
    const isActive = activeId !== undefined && activeId !== null && rowId === activeId;
    const isSelected = selection?.selectedIds.has(rowId) ?? false;
    const isSelectionDisabled = selection?.isDisabled?.(item) ?? false;
    return (
      <TableRow
        key={String(rowId)}
        data-active={isActive ? "true" : undefined}
        data-selected={isSelected ? "true" : undefined}
        className={cn(
          "group",
          onRowClick && "cursor-pointer",
          isActive && "bg-accent/60 hover:bg-accent",
          isSelected && !isActive && "bg-primary/5 hover:bg-primary/10",
        )}
        onClick={onRowClick ? () => onRowClick(item) : undefined}
      >
        {selection && (
          <TableCell
            className={cn(
              rowPadY,
              "text-center sticky left-0 z-20 bg-background shadow-sm group-hover:bg-muted group-data-[selected=true]:bg-primary/5 group-data-[active=true]:bg-accent",
            )}
            style={{ left: "0px" }}
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
          const stickyCellClass =
            col.sticky === "left"
              ? "sticky z-10 bg-background group-hover:bg-muted border-r shadow-sm group-data-[selected=true]:bg-primary/5 group-data-[active=true]:bg-accent"
              : col.sticky === "right"
                ? "sticky z-10 bg-background group-hover:bg-muted border-l shadow-sm group-data-[selected=true]:bg-primary/5 group-data-[active=true]:bg-accent"
                : "";
          const stickyCellStyle =
            col.sticky === "left"
              ? { left: col.stickyOffset ?? "0px" }
              : col.sticky === "right"
                ? { right: col.stickyOffset ?? "0px" }
                : undefined;
          return (
            <TableCell
              key={col.id}
              style={{
                ...(col.width ? { width: col.width, maxWidth: col.width } : {}),
                ...(stickyCellStyle ?? {}),
              }}
              className={cn(
                rowPadY,
                alignClass,
                "overflow-hidden",
                col.sticky === "left" && "group-hover:bg-muted group-data-[selected=true]:bg-primary/5 group-data-[active=true]:bg-accent",
                stickyCellClass,
                col.className,
              )}
            >
              <div className="min-w-0">{col.cell(item)}</div>
            </TableCell>
          );
        })}
      </TableRow>
    );
  };

  const renderCard = (item: T) => {
    const rowId = getRowId(item);
    const isActive = activeId !== undefined && activeId !== null && rowId === activeId;
    const isSelected = selection?.selectedIds.has(rowId) ?? false;
    const isSelectionDisabled = selection?.isDisabled?.(item) ?? false;
    return (
      <div
        key={String(rowId)}
        role={onRowClick ? "button" : undefined}
        tabIndex={onRowClick ? 0 : undefined}
        onClick={onRowClick ? () => onRowClick(item) : undefined}
        onKeyDown={
          onRowClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onRowClick(item);
                }
              }
            : undefined
        }
        data-active={isActive ? "true" : undefined}
        data-selected={isSelected ? "true" : undefined}
        className={cn(
          "group rounded-md border bg-card p-3 transition-colors",
          onRowClick && "cursor-pointer hover:bg-accent/40",
          isActive && "border-primary/60 bg-accent/60",
          isSelected && !isActive && "border-primary/40 bg-primary/5",
        )}
      >
        <div className="flex items-start gap-2">
          {selection && (
            <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={isSelected}
                disabled={isSelectionDisabled}
                onCheckedChange={() => selection.onToggle(rowId, item)}
                aria-label={isSelected ? "Deselect item" : "Select item"}
              />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {primaryColumn && (
              <div className="text-sm font-medium leading-tight">
                {primaryColumn.cell(item)}
              </div>
            )}
            {metaColumns.length > 0 && (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {metaColumns.map((col) => {
                  const label =
                    col.cardLabel ??
                    (typeof col.header === "string" ? col.header : col.id);
                  return (
                    <div key={col.id} className="contents">
                      <dt className="truncate text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 break-words text-foreground">
                        {col.cell(item)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>
          {onRowClick && (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={cn(className)}>
      {/* Desktop / wide tablet: classic table */}
      <div className="hidden rounded-md border lg:block">
      <div className="relative">
      <div
        ref={tableScrollRef}
        className="w-full overflow-x-auto"
      >
      <table className="w-full min-w-max caption-bottom text-sm">
        <TableHeader>
          <TableRow>
            {selection && (
              <TableHead
                style={{ width: "40px" }}
                className="text-center sticky left-0 z-20 bg-background shadow-sm"
              >
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
              const stickyHeadClass =
                col.sticky === "left"
                  ? "sticky z-10 bg-background shadow-sm border-r"
                  : col.sticky === "right"
                    ? "sticky z-10 bg-background shadow-sm border-l"
                    : "";
              const stickyHeadStyle =
                col.sticky === "left"
                  ? { left: col.stickyOffset ?? "0px" }
                  : col.sticky === "right"
                    ? { right: col.stickyOffset ?? "0px" }
                    : undefined;
              return (
                <TableHead
                  key={col.id}
                  style={{
                    ...(col.width ? { width: col.width, maxWidth: col.width } : {}),
                    ...(stickyHeadStyle ?? {}),
                  }}
                  className={cn(alignClass, stickyHeadClass, col.className)}
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
            grouping ? (
              groupedSections.map((section) => {
                const expanded = grouping.expandedGroupKeys.has(section.key);
                const useCells = !!grouping.renderGroupCell;
                return (
                  <Fragment key={`group-${section.key}`}>
                    <TableRow
                      key={`group-${section.key}`}
                      className={cn(
                        "bg-muted/20 hover:bg-muted/30",
                        useCells && "cursor-pointer",
                      )}
                      onClick={
                        useCells
                          ? () => grouping.onToggleGroup(section.key)
                          : undefined
                      }
                      aria-expanded={useCells ? expanded : undefined}
                    >
                      {useCells ? (
                        <>
                          {selection && (
                            <TableCell
                              className={cn(
                                rowPadY,
                                "text-center sticky left-0 z-20 bg-muted/20 shadow-sm",
                              )}
                              style={{ left: "0px" }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}
                          {visibleColumns.map((col) => {
                            const alignClass =
                              col.align === "right"
                                ? "text-right"
                                : col.align === "center"
                                  ? "text-center"
                                  : "";
                            const stickyCellClass =
                              col.sticky === "left"
                                ? "sticky z-10 bg-muted/20 border-r shadow-sm"
                                : col.sticky === "right"
                                  ? "sticky z-10 bg-muted/20 border-l shadow-sm"
                                  : "";
                            const stickyCellStyle =
                              col.sticky === "left"
                                ? { left: col.stickyOffset ?? "0px" }
                                : col.sticky === "right"
                                  ? { right: col.stickyOffset ?? "0px" }
                                  : undefined;
                            return (
                              <TableCell
                                key={col.id}
                                style={{
                                  ...(col.width ? { width: col.width, maxWidth: col.width } : {}),
                                  ...(stickyCellStyle ?? {}),
                                }}
                                className={cn(
                                  rowPadY,
                                  alignClass,
                                  "overflow-hidden",
                                  stickyCellClass,
                                  col.className,
                                )}
                              >
                                <div className="min-w-0">
                                  {grouping.renderGroupCell!(col, section.items, expanded)}
                                </div>
                              </TableCell>
                            );
                          })}
                        </>
                      ) : (
                        <TableCell colSpan={colSpan} className="p-0">
                          {grouping.renderGroupHeader(section.key, section.items, expanded)}
                        </TableCell>
                      )}
                    </TableRow>
                    {expanded ? section.items.map((item) => renderDataRow(item)) : null}
                  </Fragment>
                );
              })
            ) : (
              items.map((item) => renderDataRow(item))
            )
          )}
        </TableBody>
      </table>
      </div>
      {canScrollLeft && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 z-30 w-3 shadow-[inset_8px_0_10px_-10px_rgba(0,0,0,0.45)]" />
          <div className="pointer-events-none absolute inset-y-0 left-0 z-40 flex items-center pl-0.5 text-muted-foreground/70">
            <ChevronLeft className="h-3 w-3" />
          </div>
        </>
      )}
      {canScrollRight && (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 z-30 w-3 shadow-[inset_-8px_0_10px_-10px_rgba(0,0,0,0.45)]" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-40 flex items-center pr-0.5 text-muted-foreground/70">
            <ChevronRight className="h-3 w-3" />
          </div>
        </>
      )}
      </div>
      </div>

      {/* Compact (mobile + small tablet): card list */}
      <div className="flex flex-col gap-2 lg:hidden">
        {loading ? (
          Array.from({ length: loadingRows }).map((_, i) => (
            <div
              key={`card-skeleton-${i}`}
              className="rounded-md border bg-card p-3"
            >
              <Skeleton className="mb-2 h-4 w-1/2" />
              <Skeleton className="mb-1 h-3 w-3/4" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">
            {emptyState ?? "No results"}
          </div>
        ) : (
          grouping ? (
            groupedSections.map((section) => {
              const expanded = grouping.expandedGroupKeys.has(section.key);
              return (
                <div key={`group-card-${section.key}`} className="flex flex-col gap-2">
                  {grouping.renderGroupHeader(section.key, section.items, expanded)}
                  {expanded ? section.items.map((item) => renderCard(item)) : null}
                </div>
              );
            })
          ) : (
            items.map((item) => renderCard(item))
          )
        )}
      </div>
    </div>
  );
}
