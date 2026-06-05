// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Detect the platform once (Mac vs non-Mac).
 * Used to pick the correct modifier key and badge label.
 */
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Check whether a keyboard event is the Cmd+Enter / Ctrl+Enter combo. */
function isCommandEnter(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  const modifier = isMac ? e.metaKey : e.ctrlKey;
  return modifier && e.key === "Enter";
}

/**
 * Create an `onKeyDown` handler for Dialog / AlertDialog content elements.
 *
 * On `Cmd+Enter` (Mac) / `Ctrl+Enter` (Win/Linux), it finds the first
 * `[data-command-enter]` button inside the container. If the button is
 * enabled it is clicked; if disabled the keystroke is swallowed (noop)
 * so it cannot bubble up and trigger a page-level shortcut underneath
 * the open dialog.
 *
 * Used by both `DialogContent` and `AlertDialogContent` to avoid
 * duplicating the same handler logic.
 */
export function createCommandEnterKeyDown(
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void,
) {
  return (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isCommandEnter(e)) {
      const action = (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(
        "[data-command-enter]",
      );
      if (action) {
        // Always claim the keystroke when the dialog opts in via
        // [data-command-enter], even if the button is currently
        // disabled — otherwise a disabled state would let the event
        // bubble out to page-level handlers.
        e.preventDefault();
        if (!action.disabled) {
          action.click();
        }
      }
    }
    onKeyDown?.(e);
  };
}

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

      if (isCommandEnter(e)) {
        e.preventDefault();
        stableCallback();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [stableCallback, enabled]);
}
