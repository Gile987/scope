// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useCallback } from "react";

/**
 * Detect the platform once (Mac vs non-Mac).
 * Used to pick the correct modifier key and badge label.
 */
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * Register a global `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows/Linux)
 * keyboard shortcut that fires `callback` when pressed.
 *
 * The handler checks `event.defaultPrevented` so that dialog-level
 * handlers (which call `preventDefault()`) take priority over
 * page-level hooks.
 *
 * @param callback  The function to call when the shortcut is pressed.
 * @param enabled   Guard flag — the listener is only active when `true`.
 */
export function useCommandEnter(callback: () => void, enabled = true) {
  const stableCallback = useCallback(callback, [callback]);

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      // If a dialog/alert-dialog already handled the event, skip.
      if (e.defaultPrevented) return;

      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (modifier && e.key === "Enter") {
        e.preventDefault();
        stableCallback();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [stableCallback, enabled]);
}
