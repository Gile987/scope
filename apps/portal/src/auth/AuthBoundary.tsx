// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { InteractionType } from "@azure/msal-browser";
import { MsalAuthenticationTemplate } from "@azure/msal-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { authConfigErrors, loginRequest } from "./msal";
import type { ReactNode } from "react";

export function AuthBoundary({ children }: { children: ReactNode }) {
  if (authConfigErrors.length > 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Alert className="max-w-2xl">
          <AlertTitle>Portal authentication is not configured</AlertTitle>
          <AlertDescription>
            <p>The auth spec requires Microsoft Entra ID authentication with no dev bypass.</p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {authConfigErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <MsalAuthenticationTemplate
      interactionType={InteractionType.Redirect}
      authenticationRequest={loginRequest}
    >
      {children}
    </MsalAuthenticationTemplate>
  );
}
