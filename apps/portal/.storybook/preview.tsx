// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { initialize, mswLoader } from "msw-storybook-addon";
import { mswHandlers } from "./msw-handlers";
import { FeatureFlagProvider } from "../src/contexts/FeatureFlagContext";
import { ThemeProvider } from "../src/contexts/ThemeContext";
import { ProjectProvider } from "../src/contexts/ProjectContext";
import "../src/index.css";

initialize({ onUnhandledRequest: "bypass" });

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
          <FeatureFlagProvider>
            <ThemeProvider>
              <ProjectProvider>
                <MemoryRouter>
                  <Story />
                </MemoryRouter>
              </ProjectProvider>
            </ThemeProvider>
          </FeatureFlagProvider>
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
