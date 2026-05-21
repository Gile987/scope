// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export type SortDir = "asc" | "desc";

export interface ListUrlState {
  search: string;
  setSearch: (value: string) => void;
  sort: string | null;
  sortDir: SortDir;
  setSort: (column: string | null, dir?: SortDir) => void;
  toggleSort: (column: string) => void;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  getFilter: (key: string) => string | null;
  setFilter: (key: string, value: string | null | string[]) => void;
  getFilterList: (key: string) => string[];
  toggleFilterValue: (key: string, value: string) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
}

const RESERVED_KEYS = new Set(["search", "sort", "dir", "page", "size"]);

export interface UseListUrlStateOptions {
  defaultPageSize?: number;
  /**
   * Keys that should be treated as filter params and cleared by `clearFilters`.
   * If omitted, `clearFilters` clears every non-reserved key.
   */
  filterKeys?: readonly string[];
}

/**
 * Hook to manage list state (search, sort, pagination, filters) synced to URL
 * search params, so browser back/forward and direct links preserve state.
 */
export function useListUrlState(options: UseListUrlStateOptions = {}): ListUrlState {
  const { defaultPageSize = 25, filterKeys } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const sort = searchParams.get("sort");
  const sortDir = (searchParams.get("dir") as SortDir | null) ?? "asc";
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10) || 1;
  const pageSize = Number.parseInt(searchParams.get("size") ?? String(defaultPageSize), 10) || defaultPageSize;

  const update = useCallback(
    (mutator: (params: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutator(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setSearch = useCallback(
    (value: string) =>
      update((p) => {
        if (value) p.set("search", value);
        else p.delete("search");
        p.delete("page");
      }),
    [update],
  );

  const setSort = useCallback(
    (column: string | null, dir: SortDir = "asc") =>
      update((p) => {
        if (column) {
          p.set("sort", column);
          p.set("dir", dir);
        } else {
          p.delete("sort");
          p.delete("dir");
        }
      }),
    [update],
  );

  const toggleSort = useCallback(
    (column: string) => {
      const currentSort = searchParams.get("sort");
      const currentDir = searchParams.get("dir") as SortDir | null;
      update((p) => {
        if (currentSort === column) {
          if (currentDir === "asc") {
            p.set("dir", "desc");
          } else {
            p.delete("sort");
            p.delete("dir");
          }
        } else {
          p.set("sort", column);
          p.set("dir", "asc");
        }
      });
    },
    [searchParams, update],
  );

  const setPage = useCallback(
    (next: number) =>
      update((p) => {
        if (next <= 1) p.delete("page");
        else p.set("page", String(next));
      }),
    [update],
  );

  const setPageSize = useCallback(
    (size: number) =>
      update((p) => {
        if (size === defaultPageSize) p.delete("size");
        else p.set("size", String(size));
        p.delete("page");
      }),
    [update, defaultPageSize],
  );

  const getFilter = useCallback((key: string) => searchParams.get(key), [searchParams]);

  const getFilterList = useCallback(
    (key: string) => {
      const raw = searchParams.get(key);
      if (!raw) return [];
      return raw.split(",").filter(Boolean);
    },
    [searchParams],
  );

  const setFilter = useCallback(
    (key: string, value: string | null | string[]) =>
      update((p) => {
        if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
          p.delete(key);
        } else if (Array.isArray(value)) {
          p.set(key, value.join(","));
        } else {
          p.set(key, value);
        }
        p.delete("page");
      }),
    [update],
  );

  const toggleFilterValue = useCallback(
    (key: string, value: string) => {
      const current = (searchParams.get(key) ?? "").split(",").filter(Boolean);
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      setFilter(key, next);
    },
    [searchParams, setFilter],
  );

  const clearFilters = useCallback(() => {
    update((p) => {
      const keysToClear = filterKeys ?? Array.from(p.keys()).filter((k) => !RESERVED_KEYS.has(k));
      for (const k of keysToClear) p.delete(k);
      p.delete("search");
      p.delete("page");
    });
  }, [update, filterKeys]);

  const hasActiveFilters = (() => {
    if (search) return true;
    if (filterKeys) return filterKeys.some((k) => searchParams.get(k));
    for (const key of searchParams.keys()) {
      if (!RESERVED_KEYS.has(key)) return true;
    }
    return false;
  })();

  // Clamp page if it becomes invalid via setPageSize changes etc. (no-op normally)
  useEffect(() => {
    if (page < 1) setPage(1);
  }, [page, setPage]);

  return {
    search,
    setSearch,
    sort,
    sortDir,
    setSort,
    toggleSort,
    page,
    setPage,
    pageSize,
    setPageSize,
    getFilter,
    setFilter,
    getFilterList,
    toggleFilterValue,
    clearFilters,
    hasActiveFilters,
  };
}
