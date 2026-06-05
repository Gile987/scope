// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface PaginationProps {
  /** Current page (1-based). */
  page: number;
  /** Page size. */
  pageSize: number;
  /** Total number of items across all pages, if known. */
  total?: number;
  /** Available page-size options. */
  pageSizeOptions?: readonly number[];
  /** Called when the page changes. */
  onPageChange: (page: number) => void;
  /** Called when the page-size changes. */
  onPageSizeChange?: (size: number) => void;
  /** Force-disable next button (for cursor pagination when `total` is unknown). */
  hasNext?: boolean;
  /** Force-disable prev button (for cursor pagination). */
  hasPrev?: boolean;
  /** Label for items (e.g. "runs", "reports"). */
  itemLabel?: string;
  className?: string;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export function Pagination({
  page,
  pageSize,
  total,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  hasNext,
  hasPrev,
  itemLabel = "items",
  className,
}: PaginationProps) {
  const knownTotal = typeof total === "number";
  const totalPages = knownTotal ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = knownTotal ? Math.min(page * pageSize, total) : page * pageSize;

  const canPrev = hasPrev ?? page > 1;
  const canNext = hasNext ?? (totalPages !== null ? page < totalPages : true);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-between gap-3 px-1 py-2 text-sm sm:flex-row",
        className,
      )}
    >
      <div className="text-muted-foreground tabular-nums">
        {knownTotal ? (
          total === 0 ? (
            <>0 {itemLabel}</>
          ) : (
            <>
              {start}–{end} of {total} {itemLabel}
            </>
          )
        ) : (
          <>
            {start}–{end} {itemLabel}
          </>
        )}
      </div>

      <div className="flex items-center gap-4">
        {onPageSizeChange && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
              <SelectTrigger className="h-8 w-[72px]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((opt) => (
                  <SelectItem key={opt} value={String(opt)}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={!canPrev}
            onClick={() => onPageChange(1)}
            aria-label="First page"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={!canPrev}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {totalPages !== null && (
            <span className="px-2 text-muted-foreground tabular-nums">
              {page} / {totalPages}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={!canNext}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {totalPages !== null && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={!canNext || page >= totalPages}
              onClick={() => onPageChange(totalPages)}
              aria-label="Last page"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
