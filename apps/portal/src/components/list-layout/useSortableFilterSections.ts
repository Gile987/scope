// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect } from "react";

export function useSortableFilterSections(pageKey: string, defaultOrder: string[]) {
  const storageKey = `scope:filter-section-order:${pageKey}`;
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        return stored.split(",");
      }
    } catch {
      /* ignore */
    }
    return defaultOrder;
  });

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
