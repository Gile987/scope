// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Navigate } from "react-router-dom";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";
import { useAuth } from "@/auth/AuthContext";
import type { Permission } from "@/auth/permissions";
import type { ReactNode } from "react";

interface FeatureRouteProps {
  featureKey?: string;
  permissions?: Permission | Permission[];
  children: ReactNode;
}

/** UI route guard. The API remains the enforcement boundary. */
export function FeatureRoute({ featureKey, permissions, children }: FeatureRouteProps) {
  const { isFeatureEnabled } = useFeatureFlags();
  const { hasEveryPermission } = useAuth();

  if ((featureKey && !isFeatureEnabled(featureKey)) || !hasEveryPermission(permissions)) {
    return <Navigate to="/statistics" replace />;
  }

  return <>{children}</>;
}
