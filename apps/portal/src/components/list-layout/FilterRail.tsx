// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import React, { type ReactNode, useMemo } from "react";
import { Search, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSortableFilterSections } from "./useSortableFilterSections";

export interface FilterRailProps {
  /** Search input value. If undefined, the search box is hidden. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Refresh indicator (spinner). Show while data is re-fetching. */
  refreshing?: boolean;
  /** Filter sections, typically composed of <FilterSection> children. */
  children: ReactNode;
  /** Optional footer (e.g. "Clear Filters" link). */
  footer?: ReactNode;
  /** Optional page key for persisting section order (e.g., "runs"). When provided, sections become sortable. */
  sortablePageKey?: string;
  /** Default order of section IDs when sortablePageKey is provided. */
  defaultSectionOrder?: string[];
  className?: string;
}

export function FilterRail({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  refreshing,
  children,
  footer,
  sortablePageKey,
  defaultSectionOrder = [],
  className,
}: FilterRailProps) {
  const sortable = useSortableFilterSections(
    sortablePageKey || "default",
    defaultSectionOrder.length > 0 ? defaultSectionOrder : []
  );

  // Extract children and build a map of sortable IDs to elements
  const childrenArray = useMemo(() => {
    const arr: React.ReactElement[] = [];
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child)) {
        arr.push(child);
      }
    });
    return arr;
  }, [children]);

  // Create a map of sortable IDs to elements and their indices
  const childrenBySort = useMemo(() => {
    if (!sortablePageKey || defaultSectionOrder.length === 0) {
      return childrenArray;
    }

    const map = new Map<string, React.ReactElement>();
    const sortIds = new Set<string>();

    childrenArray.forEach((child) => {
      const sortableId = child.props?.sortableId;
      if (sortableId) {
        map.set(sortableId, child);
        sortIds.add(sortableId);
      }
    });

    // Reorder based on stored order
    const sorted: React.ReactElement[] = [];
    sortable.order.forEach((id) => {
      if (map.has(id)) {
        sorted.push(map.get(id)!);
      }
    });

    // Add any children without sortable IDs at the end
    childrenArray.forEach((child) => {
      if (!child.props?.sortableId && !sorted.includes(child)) {
        sorted.push(child);
      }
    });

    return sorted;
  }, [childrenArray, sortable.order, sortablePageKey, defaultSectionOrder.length]);

  const orderedChildren = useMemo(() => {
    return childrenBySort.map((child, idx) => {
      return (
        <div
          key={child.props?.sortableId || idx}
          onDragOver={child.props?.sortableId ? sortable.handleDragOver : undefined}
          onDrop={child.props?.sortableId ? sortable.handleDrop(child.props.sortableId) : undefined}
        >
          {child}
        </div>
      );
    });
  }, [childrenBySort, sortable]);

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-card/40",
        className,
      )}
      aria-label="Filters"
    >
      {search !== undefined && onSearchChange && (
        <div className="border-b border-border/60 px-3 py-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8 pr-8 text-sm"
            />
            {refreshing && (
              <RefreshCw
                className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-hidden
              />
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">{orderedChildren}</div>

      {footer && (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2.5 text-sm">
          {footer}
        </div>
      )}
    </aside>
  );
}

export interface ClearFiltersLinkProps {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}

export function ClearFiltersLink({ onClick, disabled, label = "Clear Filters" }: ClearFiltersLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "text-sm transition-colors",
        disabled
          ? "cursor-not-allowed text-muted-foreground/50"
          : "text-primary hover:text-primary/80",
      )}
    >
      {label}
    </button>
  );
}
