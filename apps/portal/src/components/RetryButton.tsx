// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect } from "react";

export interface RetryButtonProps {
  /** Whether the run completed successfully */
  isSuccessful: boolean;
  /** Whether a retry mutation is in progress */
  isPending: boolean;
  /** Callback when retry is triggered; receives { force: true } for successful runs */
  onRetry: (options: { force: boolean }) => void;
}

/**
 * Hook that tracks whether the Shift key is currently held.
 */
export function useShiftModifier() {
  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    const onBlur = () => setShiftHeld(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return shiftHeld;
}

/**
 * Computes retry button state: whether the button should be disabled
 * and what title to show.
 */
export function getRetryButtonState(isSuccessful: boolean, isPending: boolean, shiftHeld: boolean) {
  const disabled = isPending || (isSuccessful && !shiftHeld);
  const title = isSuccessful && !shiftHeld
    ? "Hold Shift to force retry a successful run"
    : undefined;
  return { disabled, title };
}
