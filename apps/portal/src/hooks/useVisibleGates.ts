// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo } from "react";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";
import { visibleGateOrder, type GateId } from "@/lib/gates";

/**
 * Returns the ordered gate list with flag-controlled gates (Run, Deploy) hidden
 * unless their feature flag is explicitly enabled.
 *
 * Unlike {@link useFeatureFlags}'s fail-open `isFeatureEnabled`, this hook is
 * fail-closed for flagged gates: while flags are loading or when a gate's flag
 * is missing/off, the gate is hidden. This keeps unfinished gates out of every
 * authoring/selection surface until an admin turns them on.
 */
export function useVisibleGates(): GateId[] {
  const { flags } = useFeatureFlags();
  return useMemo(() => {
    const enabledFlags: Record<string, boolean> = {};
    for (const flag of flags) enabledFlags[flag.key] = flag.enabled;
    return visibleGateOrder(enabledFlags);
  }, [flags]);
}
