// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useMemo } from "react";

/**
 * Merge a persisted order with the current default order:
 *   - keep stored ids that still exist in defaults (preserves user reorderings)
 *   - drop stored ids that have been removed from defaults
 *   - append new defaults that aren't in the stored order yet
 * This keeps newly-introduced sections visible without forcing a storage reset.
 */
function reconcileOrder(stored: string[], defaults: string[]): string[] {
  const defaultSet = new Set(defaults);
  const reconciled = stored.filter((id) => defaultSet.has(id));
  const seen = new Set(reconciled);
  for (const id of defaults) {
    if (!seen.has(id)) {
      reconciled.push(id);
      seen.add(id);
    }
  }
  return reconciled;
}

export function useSortableFilterSections(pageKey: string, defaultOrder: string[]) {
  const storageKey = `scope:filter-section-order:${pageKey}`;
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        return reconcileOrder(stored.split(","), defaultOrder);
      }
    } catch {
      /* ignore */
    }
    return defaultOrder;
  });

  // Re-reconcile if the defaultOrder shape changes (e.g. a new section was
  // added in a later release). Cheap because defaults are short arrays.
  const defaultsKey = useMemo(() => defaultOrder.join(","), [defaultOrder]);
  useEffect(() => {
    setOrder((prev) => {
      const next = reconcileOrder(prev, defaultsKey ? defaultsKey.split(",") : []);
      // Skip the state update when nothing changed to avoid render loops.
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
        return prev;
      }
      return next;
    });
  }, [defaultsKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, order.join(","));
    } catch {
      /* ignore */
    }
  }, [order, storageKey]);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (targetId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    
    if (draggedId === targetId) return;

    const draggedIndex = order.indexOf(draggedId);
    const targetIndex = order.indexOf(targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const newOrder = [...order];
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedId);
    
    setOrder(newOrder);
  };

  const resetOrder = () => {
    setOrder(defaultOrder);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  return { order, handleDragOver, handleDrop, resetOrder };
}
