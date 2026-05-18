// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FeatureFlagProvider } from "../src/contexts/FeatureFlagContext";
import { initialize, mswLoader } from "msw-storybook-addon";
import { mswHandlers } from "./msw-handlers";
import "../src/index.css";

initialize({ onUnhandledRequest: "bypass" });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity },
  },
});

const preview: Preview = {
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <FeatureFlagProvider>
          <MemoryRouter>
            <Story />
          </MemoryRouter>
        </FeatureFlagProvider>
      </QueryClientProvider>
    ),
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
