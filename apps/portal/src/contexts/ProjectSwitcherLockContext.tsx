// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Presentation-only lock for the header {@link file://../components/ProjectSwitcher.tsx ProjectSwitcher}.
 *
 * Entity **detail** pages set this while mounted (via
 * {@link file://../components/LockProjectSwitcher.tsx LockProjectSwitcher}) so the
 * switcher renders as a static label instead of an interactive dropdown: on a
 * single-entity page the project is fixed by the entity, so switching projects
 * there is meaningless. List pages leave it unset and stay interactive.
 *
 * This is **UI only** — it never blocks programmatic selection. Auto-scope
 * (`useAutoScopeProject`), the switcher's stale-selection self-heal, `HomeRoute`,
 * and the Projects page all still call `selectProject(...)`.
 */
interface ProjectSwitcherLockValue {
  /** True when a mounted detail page has requested the switcher be locked. */
  locked: boolean;
  /** Set/clear the lock. Called by `LockProjectSwitcher` on mount/unmount. */
  setLocked: (locked: boolean) => void;
}

// A plain boolean is sufficient (no refcount): the app uses the `<Routes>`
// component API, which renders exactly one matched route element, so at most one
// `LockProjectSwitcher` is ever mounted. On a detail->detail navigation React
// runs effect cleanups before setups within the same commit, so `setLocked(false)`
// (old) then `setLocked(true)` (new) lands on the correct value with no
// intermediate unlocked render.
//
// The default value is an inert, unlocked context so the switcher used outside a
// provider (isolated tests, stories) behaves as "never locked" instead of
// throwing — the correct, safe default.
const ProjectSwitcherLockContext = createContext<ProjectSwitcherLockValue>({
  locked: false,
  setLocked: () => {},
});

export function ProjectSwitcherLockProvider({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(false);
  // `setLocked` (a useState dispatch) is referentially stable, so consumers can
  // safely depend on it in effects without re-running.
  const value = useMemo<ProjectSwitcherLockValue>(() => ({ locked, setLocked }), [locked]);
  return (
    <ProjectSwitcherLockContext.Provider value={value}>
      {children}
    </ProjectSwitcherLockContext.Provider>
  );
}

export function useProjectSwitcherLock(): ProjectSwitcherLockValue {
  return useContext(ProjectSwitcherLockContext);
}
