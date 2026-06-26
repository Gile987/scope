// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  BrowserCacheLocation,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
  type RedirectRequest,
  type SilentRequest,
} from "@azure/msal-browser";

export interface PortalAuthClientConfig {
  provider: "entra";
  authority: string;
  clientId: string;
  scopes: string[];
  audience: string;
  knownAuthorities: string[];
}

function readCommaSeparatedEnv(raw: string | undefined): string[] {
  return raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
}

export const authClientConfig: PortalAuthClientConfig = {
  provider: "entra",
  authority: import.meta.env.VITE_AUTH_AUTHORITY ?? "",
  clientId: import.meta.env.VITE_AUTH_CLIENT_ID ?? "",
  scopes: readCommaSeparatedEnv(import.meta.env.VITE_AUTH_SCOPES),
  audience: import.meta.env.VITE_AUTH_AUDIENCE ?? "",
  knownAuthorities: readCommaSeparatedEnv(import.meta.env.VITE_AUTH_KNOWN_AUTHORITIES),
};

export const authConfigErrors = [
  authClientConfig.authority ? null : "VITE_AUTH_AUTHORITY is required",
  authClientConfig.clientId ? null : "VITE_AUTH_CLIENT_ID is required",
  authClientConfig.scopes.length > 0 ? null : "VITE_AUTH_SCOPES is required",
  authClientConfig.audience ? null : "VITE_AUTH_AUDIENCE is required",
].filter((message): message is string => Boolean(message));

const origin = typeof window === "undefined" ? "/" : window.location.origin;

export const loginRequest: RedirectRequest = {
  scopes: authClientConfig.scopes,
};

const msalConfig: Configuration = {
  auth: {
    clientId: authClientConfig.clientId || "missing-client-id",
    authority: authClientConfig.authority || "https://login.microsoftonline.com/common",
    redirectUri: origin,
    postLogoutRedirectUri: origin,
    knownAuthorities: authClientConfig.knownAuthorities,
  },
  cache: {
    cacheLocation: BrowserCacheLocation.SessionStorage,
  },
};

export const msalInstance = new PublicClientApplication(msalConfig);
void msalInstance.initialize();

export function getActiveAccount(): AccountInfo | null {
  const activeAccount = msalInstance.getActiveAccount();
  if (activeAccount) return activeAccount;

  const [firstAccount] = msalInstance.getAllAccounts();
  if (firstAccount) {
    msalInstance.setActiveAccount(firstAccount);
    return firstAccount;
  }

  return null;
}

export async function acquirePortalAccessToken(): Promise<string> {
  if (authConfigErrors.length > 0) {
    throw new Error(`Portal auth is not configured: ${authConfigErrors.join(", ")}`);
  }

  const account = getActiveAccount();
  if (!account) {
    await msalInstance.loginRedirect(loginRequest);
    throw new Error("Authentication redirect started");
  }

  const silentRequest: SilentRequest = {
    ...loginRequest,
    account,
  };

  try {
    const result = await msalInstance.acquireTokenSilent(silentRequest);
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await msalInstance.acquireTokenRedirect(loginRequest);
      throw new Error("Authentication redirect started");
    }
    throw error;
  }
}

export async function redirectToLogin(): Promise<void> {
  if (authConfigErrors.length > 0) return;
  await msalInstance.loginRedirect(loginRequest);
}
