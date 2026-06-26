// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { FeatureFlag } from "@/types";

interface FeatureFlagContextValue {
  /** All feature flags from the API */
  flags: FeatureFlag[];
  /** Whether flags are still loading */
  isLoading: boolean;
  /** Check if a feature is globally enabled. Returns true while flags load or when a flag is absent. */
  isFeatureEnabled: (key: string) => boolean;
}

const FeatureFlagContext = createContext<FeatureFlagContextValue>({
  flags: [],
  isLoading: true,
  isFeatureEnabled: () => true,
});

export function FeatureFlagProvider({ children }: { children: ReactNode }) {
  const { data: flags = [], isLoading } = useQuery({
    queryKey: ["feature-flags"],
    queryFn: api.listFeatureFlags,
    staleTime: 30_000, // Cache flags for 30s to avoid excessive requests
  });

  function isFeatureEnabled(key: string): boolean {
    if (isLoading || flags.length === 0) return true;
    const flag = flags.find((f) => f.key === key);
    return flag?.enabled ?? true;
  }

  return (
    <FeatureFlagContext.Provider
      value={{
        flags,
        isLoading,
        isFeatureEnabled,
      }}
    >
      {children}
    </FeatureFlagContext.Provider>
  );
}

export function useFeatureFlags() {
  return useContext(FeatureFlagContext);
}
