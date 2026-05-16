// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
