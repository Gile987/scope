// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MsalProvider } from "@azure/msal-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/auth/AuthContext";
import { msalInstance } from "@/auth/msal";
import { FeatureFlagProvider } from "@/contexts/FeatureFlagContext";
import { FeatureRoute } from "./FeatureRoute";
import type { AuthenticatedUser } from "@/auth/types";

vi.mock("@/lib/api", () => ({
  api: {
    getMe: vi.fn(),
    listFeatureFlags: vi.fn().mockResolvedValue([]),
  },
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear?.();
});

const ADMIN_USER: AuthenticatedUser = {
  id: "admin-user",
  role: "admin",
  permissions: ["scope/*:admin"],
};

const REGULAR_USER: AuthenticatedUser = {
  id: "regular-user",
  role: "user",
  permissions: ["scope/run:read", "scope/run:write"],
};

function renderRoute(user: AuthenticatedUser, initialPath = "/admin") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MsalProvider instance={msalInstance}>
        <AuthProvider initialUser={user}>
          <FeatureFlagProvider>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route path="/statistics" element={<div>Statistics page</div>} />
                <Route
                  path="/admin"
                  element={
                    <FeatureRoute featureKey="admin" permissions="scope/user:admin">
                      <div>Admin page</div>
                    </FeatureRoute>
                  }
                />
                <Route
                  path="/runs"
                  element={
                    <FeatureRoute featureKey="runs" permissions="scope/run:read">
                      <div>Runs page</div>
                    </FeatureRoute>
                  }
                />
              </Routes>
            </MemoryRouter>
          </FeatureFlagProvider>
        </AuthProvider>
      </MsalProvider>
    </QueryClientProvider>,
  );
}

describe("FeatureRoute", () => {
  it("redirects users without required permissions", async () => {
    renderRoute(REGULAR_USER);

    await waitFor(() => expect(screen.getByText("Statistics page")).toBeTruthy());
  });

  it("allows users with wildcard admin permissions", () => {
    renderRoute(ADMIN_USER);

    expect(screen.getByText("Admin page")).toBeTruthy();
  });

  it("allows users with the exact route permission", () => {
    renderRoute(REGULAR_USER, "/runs");

    expect(screen.getByText("Runs page")).toBeTruthy();
  });
});
