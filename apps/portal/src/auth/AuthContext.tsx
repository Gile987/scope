// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { hasEveryPermission, hasPermission, type Permission } from "./permissions";
import type { AuthenticatedUser } from "./types";

interface AuthContextValue {
  user: AuthenticatedUser | null;
  role: AuthenticatedUser["role"] | null;
  permissions: Permission[];
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => void;
  hasPermission: (permission: Permission) => boolean;
  hasEveryPermission: (permissions: Permission | readonly Permission[] | undefined) => boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  role: null,
  permissions: [],
  isAuthenticated: false,
  isLoading: true,
  logout: () => undefined,
  hasPermission: () => false,
  hasEveryPermission: () => false,
});

interface AuthProviderProps {
  children: ReactNode;
  initialUser?: AuthenticatedUser;
}

export function AuthProvider({ children, initialUser }: AuthProviderProps) {
  const { instance } = useMsal();
  const isMsalAuthenticated = useIsAuthenticated();
  const shouldFetchMe = isMsalAuthenticated && !initialUser;

  const value = useMemo<AuthContextValue>(() => {
    return {
      user: initialUser ?? null,
      role: initialUser?.role ?? null,
      permissions: initialUser?.permissions ?? [],
      isAuthenticated: Boolean(initialUser) || isMsalAuthenticated,
      isLoading: !initialUser && isMsalAuthenticated,
      logout: () => {
        void instance.logoutRedirect();
      },
      hasPermission: (permission) => hasPermission(initialUser?.permissions ?? [], permission),
      hasEveryPermission: (permissions) =>
        hasEveryPermission(initialUser?.permissions ?? [], permissions),
    };
  }, [initialUser, instance, isMsalAuthenticated]);

  const { data: user, isLoading } = useQuery({
    queryKey: ["users", "me"],
    queryFn: api.getMe,
    enabled: shouldFetchMe,
    staleTime: 30_000,
  });

  const resolvedValue = useMemo<AuthContextValue>(() => {
    const resolvedUser = initialUser ?? user ?? null;
    const permissions = resolvedUser?.permissions ?? [];

    return {
      user: resolvedUser,
      role: resolvedUser?.role ?? null,
      permissions,
      isAuthenticated: Boolean(resolvedUser) || isMsalAuthenticated,
      isLoading,
      logout: () => {
        void instance.logoutRedirect();
      },
      hasPermission: (permission) => hasPermission(permissions, permission),
      hasEveryPermission: (required) => hasEveryPermission(permissions, required),
    };
  }, [initialUser, instance, isLoading, isMsalAuthenticated, user]);

  return <AuthContext.Provider value={initialUser ? value : resolvedValue}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
