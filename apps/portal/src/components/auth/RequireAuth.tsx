// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Route guard that gates the app behind Microsoft Entra ID sign-in.
 *
 * Signed-out users are NOT auto-redirected to the IdP. Instead we render a
 * minimal placeholder page (a real landing page will replace it later) with a
 * "Log in" button; the interactive redirect only starts when the user clicks it.
 * Authentication only — no roles/permissions are checked here (see
 * docs/architecture/auth-rbac.md §8, subtask 10).
 *
 * When the Portal auth config is missing (a production build without the
 * `VITE_AUTH_*` env vars), we render a clear configuration error instead of
 * bouncing into a broken redirect loop.
 */
import type { ReactNode } from "react";
import { InteractionStatus } from "@azure/msal-browser";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { isAuthConfigured, isAuthEnabled } from "@/lib/auth/msalInstance";

function AuthPending({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
          aria-hidden
        />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

/**
 * Placeholder shown to signed-out users. Intentionally minimal — a real landing
 * page will replace it later. Its only job for now is to let the user start
 * sign-in explicitly (no automatic redirect).
 */
function Landing() {
  const { login } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Button onClick={() => void login()}>Log in</Button>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground">
          Authentication not configured
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This build is missing its identity-provider configuration
          (<code>VITE_AUTH_*</code>). Set the Entra ID values at build time and
          redeploy.
        </p>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const { inProgress } = useMsal();

  // Auth feature disabled → no gate at all; render the app as-is.
  if (!isAuthEnabled) {
    return <>{children}</>;
  }

  if (!isAuthConfigured) {
    return <NotConfigured />;
  }

  if (isAuthenticated) {
    return <>{children}</>;
  }

  // A redirect sign-in (or the initial redirect-handshake on load) is settling —
  // show a spinner rather than flashing the landing page.
  if (
    inProgress !== InteractionStatus.None &&
    inProgress !== InteractionStatus.Logout
  ) {
    return <AuthPending label="Signing in…" />;
  }

  return <Landing />;
}
