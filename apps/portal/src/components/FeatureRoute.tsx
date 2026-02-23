// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Navigate } from "react-router-dom";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";
import type { ReactNode } from "react";

interface FeatureRouteProps {
  featureKey: string;
  children: ReactNode;
}

/** Route guard that redirects to /statistics when a feature flag is disabled */
export function FeatureRoute({ featureKey, children }: FeatureRouteProps) {
  const { isFeatureEnabled } = useFeatureFlags();

  if (!isFeatureEnabled(featureKey)) {
    return <Navigate to="/statistics" replace />;
  }

  return <>{children}</>;
}
