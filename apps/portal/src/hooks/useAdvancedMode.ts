// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useEffect, useState } from "react";

/**
 * Persisted "advanced mode" preference for the Submit Run form.
 *
 * A single global toggle reveals power-user fields (e.g. Priority, Agent
 * version) that are hidden from most users behind per-section advanced
 * blocks. The preference is stored in localStorage so power users only have
 * to flip it once.
 */
const STORAGE_KEY = "scope:submit-run:advanced";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Returns `[advanced, setAdvanced]` backed by localStorage. SSR-safe and
 * resilient to storage access being unavailable (private mode, etc.).
 */
export function useAdvancedMode(): [boolean, (value: boolean) => void] {
  const [advanced, setAdvancedState] = useState<boolean>(readInitial);

  const setAdvanced = useCallback((value: boolean) => {
    setAdvancedState(value);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, advanced ? "true" : "false");
    } catch {
      // Ignore write failures (e.g. storage disabled); state still works
      // for the current session.
    }
  }, [advanced]);

  return [advanced, setAdvanced];
}
