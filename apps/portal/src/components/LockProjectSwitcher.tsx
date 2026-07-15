// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, type ReactNode } from "react";

import { useProjectSwitcherLock } from "@/contexts/ProjectSwitcherLockContext";

/**
 * Route-tree wrapper for **project-scoped entity detail** pages (mirrors
 * {@link file://./ProjectGate.tsx ProjectGate}). While mounted it locks the header
 * {@link file://./ProjectSwitcher.tsx ProjectSwitcher} so the active project can't
 * be changed from a single-entity page — the entity fixes the project, so
 * switching there is meaningless.
 *
 * Wrapping in the route tree (rather than a per-page hook) keeps `App.tsx` the
 * single source of truth for which routes are detail pages and needs no edits to
 * the page components themselves. The lock is presentation-only; see
 * {@link file://../contexts/ProjectSwitcherLockContext.tsx ProjectSwitcherLockContext}.
 */
export function LockProjectSwitcher({ children }: { children: ReactNode }) {
  const { setLocked } = useProjectSwitcherLock();
  useEffect(() => {
    setLocked(true);
    return () => setLocked(false);
  }, [setLocked]);
  return <>{children}</>;
}
