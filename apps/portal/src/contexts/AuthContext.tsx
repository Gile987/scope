// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Portal authentication context (Microsoft Entra ID via MSAL).
 *
 * Authentication only — there is no authorization here (no roles/permissions).
 * Identity is derived from the **MSAL account token claims**, not from an API
 * endpoint: the API does not verify tokens yet, so `GET /api/v1/users/me` is
 * intentionally not called (see docs/architecture/auth-rbac.md §8, subtask 10).
 *
 * When roles/permissions land, this context is the place to add them (populated
 * from `/users/me`) without touching call sites.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import type { AccountInfo } from "@azure/msal-browser";
import { login as msalLogin, logout as msalLogout } from "@/lib/auth/msalInstance";

/** The signed-in user, projected from MSAL account claims. */
export interface AuthUser {
  /** Display name (`name` claim), falling back to the username. */
  name: string;
  /** `preferred_username` / UPN / email. */
  username: string;
  /** Stable IdP subject (`localAccountId`), useful as a client-side key. */
  subject: string;
}

interface AuthContextValue {
  /** Raw MSAL account, or `null` when signed out. */
  account: AccountInfo | null;
  /** Projected user identity, or `null` when signed out. */
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** `true` until MSAL has finished any in-flight redirect handshake. */
  isReady: boolean;
  /** Start an interactive redirect sign-in. */
  login: () => Promise<void>;
  /** Sign out via redirect. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Raw auth context. Exported so stories/tests can provide a deterministic value
 * without standing up MSAL. Application code should use {@link useAuth}.
 */
export { AuthContext };
export type { AuthContextValue };

function toUser(account: AccountInfo | null): AuthUser | null {
  if (!account) return null;
  const username = account.username || "";
  return {
    name: account.name || username || "Signed in",
    username,
    subject: account.localAccountId || account.homeAccountId || username,
  };
}

export interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const account = instance.getActiveAccount() ?? accounts[0] ?? null;

  const value = useMemo<AuthContextValue>(
    () => ({
      account,
      user: toUser(account),
      isAuthenticated,
      isReady: inProgress === "none",
      login: msalLogin,
      logout: msalLogout,
    }),
    // `account` identity changes when the active account or account list does;
    // depending on the id keeps the memo stable across benign re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account?.homeAccountId, isAuthenticated, inProgress],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
