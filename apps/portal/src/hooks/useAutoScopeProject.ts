// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useRef } from "react";

import { useSelectedProjectId } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";

/**
 * Scope the whole app to a resource's **own** project when its detail page is
 * opened directly (a shared link, bookmark, or typed URL).
 *
 * Some detail routes (e.g. `/runs/:id`) are intentionally **not** wrapped in
 * {@link file://../components/ProjectGate.tsx ProjectGate} so the resource is
 * always viewable, even with no project selected. But then the surrounding shell
 * — the "Back to …" link, the left nav, and any project-scoped pieces of the
 * page — points at whatever (possibly wrong) project was previously active. This
 * hook fixes that by selecting the resource's project once it is known.
 *
 * Behavior:
 * - Selects **once per resource id** (ref-guarded). This prevents an update loop,
 *   avoids fighting {@link file://../components/ProjectSwitcher.tsx ProjectSwitcher}'s
 *   self-heal effect when the resource's project isn't in the user's list, and
 *   lets the user manually switch projects afterward without being snapped back.
 * - Always switches to the resource's project when it differs from the current
 *   selection (not merely a fill-in when none is selected).
 * - No-ops until both `resourceId` and `resourceProjectId` are known.
 *
 * `preserveQueryKeyRoots` is forwarded to {@link useSelectProject} so a page can
 * keep its own **unscoped, id-keyed** queries from being reset on the switch (see
 * that hook's docs) — avoiding a needless loading flash. Pass a **stable**
 * (module-level) array so this hook's effect isn't re-armed every render.
 */
export function useAutoScopeProject(
  resourceId: string | undefined,
  resourceProjectId: string | undefined,
  preserveQueryKeyRoots?: readonly string[],
): void {
  const selectedProjectId = useSelectedProjectId();
  const selectProject = useSelectProject();
  const autoSelectedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!resourceId || !resourceProjectId) return;
    if (autoSelectedRef.current === resourceId) return;
    autoSelectedRef.current = resourceId;
    if (resourceProjectId !== selectedProjectId) {
      selectProject(resourceProjectId, { preserveQueryKeyRoots });
    }
  }, [
    resourceId,
    resourceProjectId,
    selectedProjectId,
    selectProject,
    preserveQueryKeyRoots,
  ]);
}
