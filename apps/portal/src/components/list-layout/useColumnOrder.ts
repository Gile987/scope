// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useEffect, useState } from "react";

export interface UseColumnOrderOptions {
  /** localStorage key suffix (the final key is `scope:column-order:<key>`). */
  storageKey: string;
  /** Natural column order — used to hydrate defaults and reconcile new ids. */
  columnIds: readonly string[];
}

export interface ColumnOrderState {
  /** Reconciled, persisted order. Always covers every id in `columnIds`. */
  order: readonly string[];
  /** Commit a new order — must contain only ids from `columnIds`. */
  setOrder: (next: readonly string[]) => void;
  /** Reset to the natural order. */
  reset: () => void;
}

/**
 * Reconcile a stored order against the current set of `columnIds`. Removes
 * unknown ids (from previous releases) and appends any ids the user has not
 * positioned yet (e.g. a brand-new column shipped after they configured the
 * panel) so the order is always complete.
 */
function reconcile(stored: readonly string[], columnIds: readonly string[]): string[] {
  const known = stored.filter((id) => columnIds.includes(id));
  const missing = columnIds.filter((id) => !known.includes(id));
  return [...known, ...missing];
}

function parseStored(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

/**
 * localStorage-backed ordered list of column ids for `CustomizeColumnsPanel`.
 *
 * Hydration is reconciled: unknown ids are dropped and new ids are appended,
 * so users never lose access to columns added in future releases.
 */
export function useColumnOrder({
  storageKey,
  columnIds,
}: UseColumnOrderOptions): ColumnOrderState {
  const fullKey = `scope:column-order:${storageKey}`;
  // Stable signature used to detect changes in `columnIds` between renders
  // without forcing callers to memoize the array.
  const columnIdsSignature = columnIds.join("\u0000");

  const [order, setOrderState] = useState<string[]>(() => {
    const stored = parseStored(typeof localStorage !== "undefined" ? localStorage.getItem(fullKey) : null);
    return reconcile(stored ?? [...columnIds], columnIds);
  });

  const persist = useCallback(
    (next: readonly string[]) => {
      try {
        localStorage.setItem(fullKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [fullKey],
  );

  // Reconcile whenever the underlying columnIds change (new release adds or
  // removes a column). Only update + persist when the result differs to avoid
  // re-render loops.
  useEffect(() => {
    setOrderState((prev) => {
      const next = reconcile(prev, columnIds);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
        return prev;
      }
      persist(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnIdsSignature, persist]);

  const setOrder = useCallback(
    (next: readonly string[]) => {
      const reconciled = reconcile(next, columnIds);
      setOrderState(reconciled);
      persist(reconciled);
    },
    [columnIds, persist],
  );

  const reset = useCallback(() => {
    const next = [...columnIds];
    setOrderState(next);
    persist(next);
  }, [columnIds, persist]);

  return { order, setOrder, reset };
}
