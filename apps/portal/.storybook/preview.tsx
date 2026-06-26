// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MsalProvider } from "@azure/msal-react";
import { MemoryRouter } from "react-router-dom";
import { initialize, mswLoader } from "msw-storybook-addon";
import { mswHandlers } from "./msw-handlers";
import { ThemeProvider } from "../src/contexts/ThemeContext";
import { AuthProvider } from "../src/auth/AuthContext";
import { msalInstance } from "../src/auth/msal";
import type { AuthenticatedUser } from "../src/auth/types";
import "../src/index.css";

initialize({ onUnhandledRequest: "bypass" });

const STORYBOOK_USER: AuthenticatedUser = {
  id: "storybook-user",
  role: "admin",
  permissions: ["scope/*:admin"],
  name: "Storybook Admin",
  email: "storybook-admin@scope.local",
  idp: "entra",
};

const preview: Preview = {
  decorators: [
    (Story) => {
      localStorage.setItem("scope:theme", "light");
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
        },
      });
      return (
        <QueryClientProvider client={queryClient}>
          <MsalProvider instance={msalInstance}>
            <AuthProvider initialUser={STORYBOOK_USER}>
              <ThemeProvider>
                <MemoryRouter>
                  <Story />
                </MemoryRouter>
              </ThemeProvider>
            </AuthProvider>
          </MsalProvider>
        </QueryClientProvider>
      );
    },
  ],
  loaders: [mswLoader],
  parameters: {
    msw: { handlers: mswHandlers },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
