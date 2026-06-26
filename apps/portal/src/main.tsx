// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Scope Portal - Application entrypoint
// Renders the React app with routing and query client
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MsalProvider } from "@azure/msal-react";
import { App } from "./App";
import { AuthBoundary } from "@/auth/AuthBoundary";
import { AuthProvider } from "@/auth/AuthContext";
import { msalInstance } from "@/auth/msal";
import { FeatureFlagProvider } from "@/contexts/FeatureFlagContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <MsalProvider instance={msalInstance}>
      <AuthBoundary>
        <ThemeProvider>
          <AuthProvider>
            <FeatureFlagProvider>
              <BrowserRouter>
                <App />
                <Toaster />
              </BrowserRouter>
            </FeatureFlagProvider>
          </AuthProvider>
        </ThemeProvider>
      </AuthBoundary>
    </MsalProvider>
  </QueryClientProvider>
);
