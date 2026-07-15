// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useProjectContext } from "@/contexts/ProjectContext";

/**
 * Query-key families that are **project-independent** and must survive a project
 * switch: the projects list itself (top-bar switcher, {@link ProjectGate}) and
 * the app-level feature flags (nav). Everything else is scoped — or, for the few
 * genuinely global families (agents, models, …), refetches identical data — so
 * it is safe to drop on switch. Matched against `queryKey[0]`.
 */
const GLOBAL_QUERY_KEY_ROOTS = new Set(["projects", "feature-flags"]);

/**
 * Returns a function that switches the active project **and** resets the scoped
 * TanStack Query cache.
 *
 * The API facade reads the selected project id from a module-level holder (see
 * {@link file://../lib/project-scope.ts}), so scoped query keys do **not**
 * include the project id. That means every cached scoped entry belongs to the
 * *previous* project after a switch.
 *
 * We **reset** (not merely invalidate) those entries. `invalidateQueries` only
 * marks queries stale and refetches in the background, so `stale-while-revalidate`
 * keeps the previous project's rows on screen during the refetch — and leaves the
 * stale data in cache for any scoped page that mounts right after we navigate,
 * which briefly renders the wrong project's data. `resetQueries` instead clears
 * the cached data to a hard loading state and refetches active queries under the
 * new scope, so scoped pages show a spinner and then the correct data. The two
 * project-independent families ({@link GLOBAL_QUERY_KEY_ROOTS}) are preserved so
 * the switcher and nav don't flash.
 *
 * Passing `undefined` clears the selection (used when e.g. the active project is
 * deleted).
 *
 * `opts.preserveQueryKeyRoots` lets a caller keep additional query-key families
 * (matched against `queryKey[0]`) from being reset — on top of the built-in
 * {@link GLOBAL_QUERY_KEY_ROOTS}. This is for pages whose data is **unscoped** and
 * keyed by a stable id (e.g. a run point-read on the run detail page): such
 * entries are project-independent, so resetting them on a project switch only
 * causes a needless loading flash. Only pass roots you know are project-independent.
 */
export function useSelectProject(): (
  projectId: string | undefined,
  opts?: { preserveQueryKeyRoots?: readonly string[] },
) => void {
  const { setSelectedProjectId } = useProjectContext();
  const queryClient = useQueryClient();

  return useCallback(
    (projectId: string | undefined, opts?: { preserveQueryKeyRoots?: readonly string[] }) => {
      setSelectedProjectId(projectId);
      const preserved = opts?.preserveQueryKeyRoots;
      // Keys don't carry projectId, so every scoped entry now belongs to the
      // previous project. Reset (clear + refetch) rather than invalidate so no
      // stale rows flash before the new project's data arrives; keep the
      // project-independent shell queries intact, plus any caller-preserved roots.
      void queryClient.resetQueries({
        predicate: (query) => {
          const root = String(query.queryKey[0]);
          if (GLOBAL_QUERY_KEY_ROOTS.has(root)) return false;
          if (preserved?.includes(root)) return false;
          return true;
        },
      });
    },
    [setSelectedProjectId, queryClient],
  );
}
