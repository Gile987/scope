// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useProjectContext } from "@/contexts/ProjectContext";

/**
 * Returns a function that switches the active project **and** invalidates the
 * TanStack Query cache.
 *
 * The API facade reads the selected project id from a module-level holder (see
 * {@link file://../lib/project-scope.ts}), so scoped query keys do **not**
 * include the project id. Without invalidation, switching projects would keep
 * showing the previous project's cached rows until each query happened to
 * refetch. Invalidating everything forces every active query to refetch under
 * the new scope; unscoped families (agents, models, …) simply refetch identical
 * data, which is harmless.
 *
 * Passing `undefined` clears the selection (used when e.g. the active project is
 * deleted).
 */
export function useSelectProject(): (projectId: string | undefined) => void {
  const { setSelectedProjectId } = useProjectContext();
  const queryClient = useQueryClient();

  return useCallback(
    (projectId: string | undefined) => {
      setSelectedProjectId(projectId);
      // Keys don't carry projectId, so drop all cached scoped data on switch.
      void queryClient.invalidateQueries();
    },
    [setSelectedProjectId, queryClient],
  );
}
