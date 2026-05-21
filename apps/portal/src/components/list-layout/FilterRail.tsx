// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode } from "react";
import { Search, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
  className?: string;
}

export function FilterRail({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  refreshing,
  children,
  footer,
  className,
}: FilterRailProps) {
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

      <div className="flex-1 overflow-y-auto">{children}</div>

      {footer && (
        <div className="border-t border-border/60 px-3 py-2.5 text-sm">{footer}</div>
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
