// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Route guard that gates the app behind Microsoft Entra ID sign-in.
 *
 * Unauthenticated users are redirected to the IdP via MSAL's redirect flow
 * (`MsalAuthenticationTemplate`). Authentication only — no roles/permissions are
 * checked here (see docs/architecture/auth-rbac.md §8, subtask 10).
 *
 * When the Portal auth config is missing (a production build without the
 * `VITE_AUTH_*` env vars), we render a clear configuration error instead of
 * bouncing into a broken redirect loop.
 */
import type { ReactNode } from "react";
import { InteractionType } from "@azure/msal-browser";
import { MsalAuthenticationTemplate } from "@azure/msal-react";
import { loginRequestScopes } from "@/lib/auth/authConfig";
import { isAuthConfigured } from "@/lib/auth/msalInstance";

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

function AuthError() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground">Sign-in failed</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn&apos;t complete authentication. Refresh the page to try
          again, or contact an administrator if the problem persists.
        </p>
      </div>
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
  if (!isAuthConfigured) {
    return <NotConfigured />;
  }

  return (
    <MsalAuthenticationTemplate
      interactionType={InteractionType.Redirect}
      authenticationRequest={{ scopes: loginRequestScopes }}
      loadingComponent={() => <AuthPending label="Signing in…" />}
      errorComponent={AuthError}
    >
      {children}
    </MsalAuthenticationTemplate>
  );
}
