// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import type { ListUrlState, SortDir } from "./useListUrlState";

export interface UsePersistentSortOptions {
  pageKey: string;
}

/**
 * Hook to persist sort preferences to localStorage.
 * Automatically saves sort column and direction when they change,
 * and can restore them if no sort params are in the URL.
 */
export function usePersistentSort(
  state: ListUrlState,
  options: UsePersistentSortOptions,
): void {
  const { pageKey } = options;
  const storageKey = `scope:sort-preference:${pageKey}`;

  // Save sort preference to localStorage whenever it changes
  useEffect(() => {
    if (state.sort) {
      const sortPref = JSON.stringify({
        column: state.sort,
        direction: state.sortDir,
      });
      localStorage.setItem(storageKey, sortPref);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [state.sort, state.sortDir, storageKey]);
}

/**
 * Retrieves the saved sort preference from localStorage.
 * Returns { column: string, direction: SortDir } or null if not found.
 */
export function getSavedSortPreference(
  pageKey: string,
): { column: string; direction: SortDir } | null {
  const storageKey = `scope:sort-preference:${pageKey}`;
  const saved = localStorage.getItem(storageKey);
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

/**
 * Initializes sort state from localStorage if no sort params are in the URL.
 * Call this after creating the URL state to apply the saved preference.
 */
export function initSortFromLocalStorage(
  state: ListUrlState,
  pageKey: string,
): void {
  // Only apply saved sort if no sort is already in the URL
  if (!state.sort) {
    const saved = getSavedSortPreference(pageKey);
    if (saved) {
      state.setSort(saved.column, saved.direction);
    }
  }
}
