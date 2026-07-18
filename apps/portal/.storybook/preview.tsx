// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { initialize, mswLoader } from "msw-storybook-addon";
import { mswHandlers } from "./msw-handlers";
import { FeatureFlagProvider } from "../src/contexts/FeatureFlagContext";
import { ThemeProvider } from "../src/contexts/ThemeContext";
import { AuthProvider } from "../src/contexts/AuthContext";
import { ProjectProvider } from "../src/contexts/ProjectContext";
import "../src/index.css";

initialize({ onUnhandledRequest: "bypass" });

// Un-authenticated MSAL instance so components that read auth state (e.g. the
// header UserMenu inside Layout) can render in Storybook without a live IdP.
// Stories that need a signed-in state provide their own AuthContext value.
const msalInstance = new PublicClientApplication({
  auth: { clientId: "storybook-client-id" },
});

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
            <AuthProvider>
              <FeatureFlagProvider>
                <ThemeProvider>
                  <ProjectProvider>
                    <MemoryRouter>
                      <Story />
                    </MemoryRouter>
                  </ProjectProvider>
                </ThemeProvider>
              </FeatureFlagProvider>
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
