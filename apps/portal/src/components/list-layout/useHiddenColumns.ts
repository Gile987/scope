// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useState } from "react";

export interface UseHiddenColumnsOptions {
  /** localStorage key suffix (the final key is `scope:hidden-columns:<key>`). */
  storageKey: string;
  /** Columns hidden by default. Applied only on first mount when no value is stored. */
  defaultHidden?: readonly string[];
}

export interface HiddenColumnsState {
  hidden: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  toggle: (id: string) => void;
  setHidden: (ids: Iterable<string>) => void;
  reset: () => void;
}

/**
 * localStorage-backed Set<string> tracking which columns are hidden.
 *
 * Storing the *hidden* set (rather than visible) means that columns added in
 * future releases default to visible, so users don't lose new functionality.
 */
export function useHiddenColumns({
  storageKey,
  defaultHidden = [],
}: UseHiddenColumnsOptions): HiddenColumnsState {
  const fullKey = `scope:hidden-columns:${storageKey}`;

  const [hidden, setHiddenState] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed)) return new Set(parsed);
      }
    } catch {
      /* ignore */
    }
    return new Set(defaultHidden);
  });

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(fullKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [fullKey],
  );

  const toggle = useCallback(
    (id: string) => {
      setHiddenState((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const setHidden = useCallback(
    (ids: Iterable<string>) => {
      const next = new Set(ids);
      setHiddenState(next);
      persist(next);
    },
    [persist],
  );

  const reset = useCallback(() => {
    const next = new Set(defaultHidden);
    setHiddenState(next);
    persist(next);
  }, [defaultHidden, persist]);

  const isHidden = useCallback((id: string) => hidden.has(id), [hidden]);

  return { hidden, isHidden, toggle, setHidden, reset };
}
