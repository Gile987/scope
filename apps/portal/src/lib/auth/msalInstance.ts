// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Single {@link PublicClientApplication} instance for the Portal.
 *
 * MSAL is created here (outside React) so non-React code — notably the API
 * transport interceptor in [`../api-client.ts`](../api-client.ts) — can acquire
 * tokens without hooks. React components use `@azure/msal-react`'s hooks against
 * this same instance via `<MsalProvider>`.
 *
 * See [docs/architecture/auth-rbac.md](../../../../../docs/architecture/auth-rbac.md) §8.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-browser";
import {
  authConfig,
  apiTokenRequestScopes,
  buildMsalConfiguration,
  loginRequestScopes,
} from "./authConfig";

/** The shared MSAL instance backing both React hooks and the API interceptor. */
export const msalInstance = new PublicClientApplication(buildMsalConfiguration());

let initialized = false;
let initPromise: Promise<void> | undefined;

/** Pick a stable active account: the current one, else the first cached. */
function ensureActiveAccount(): AccountInfo | null {
  const active = msalInstance.getActiveAccount();
  if (active) return active;
  const [first] = msalInstance.getAllAccounts();
  if (first) {
    msalInstance.setActiveAccount(first);
    return first;
  }
  return null;
}

/**
 * Initialize MSAL and complete any in-flight redirect sign-in. Idempotent —
 * safe to call from both the bootstrap path and React effects; the underlying
 * work runs at most once.
 */
export async function initializeAuth(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await msalInstance.initialize();
    const result = await msalInstance.handleRedirectPromise();
    if (result?.account) {
      msalInstance.setActiveAccount(result.account);
    } else {
      ensureActiveAccount();
    }
    initialized = true;
  })();

  return initPromise;
}

/** Start an interactive redirect sign-in. */
export async function login(): Promise<void> {
  await initializeAuth();
  await msalInstance.loginRedirect({ scopes: loginRequestScopes });
}

/** Sign out via redirect, clearing the cached account. */
export async function logout(): Promise<void> {
  await initializeAuth();
  await msalInstance.logoutRedirect({
    account: msalInstance.getActiveAccount() ?? undefined,
  });
}

/**
 * Acquire an API access token silently.
 *
 * Returns the raw bearer token, or `undefined` when there is no signed-in
 * account or silent acquisition needs user interaction. The caller (the API
 * interceptor / route guard) decides whether to trigger an interactive
 * redirect — this function never redirects on its own so it is safe to call on
 * every outgoing request.
 */
export async function acquireApiToken(
  options: { forceRefresh?: boolean } = {},
): Promise<string | undefined> {
  await initializeAuth();
  const account = ensureActiveAccount();
  if (!account) return undefined;

  try {
    const result: AuthenticationResult = await msalInstance.acquireTokenSilent({
      account,
      scopes: apiTokenRequestScopes,
      forceRefresh: options.forceRefresh ?? false,
    });
    return result.accessToken || undefined;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) return undefined;
    // Re-throw unexpected errors so they surface rather than silently
    // dropping the Authorization header on a transient failure.
    throw error;
  }
}

/** Trigger an interactive redirect to (re)acquire a token for the API scopes. */
export async function acquireApiTokenRedirect(): Promise<void> {
  await initializeAuth();
  await msalInstance.acquireTokenRedirect({ scopes: apiTokenRequestScopes });
}

/** Whether a Portal auth config was resolved (see {@link authConfig}). */
export const isAuthConfigured = authConfig.isConfigured;
