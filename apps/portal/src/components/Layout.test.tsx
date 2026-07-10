// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { Layout } from "./Layout";

// The portal defines these build-time constants via Vite `define`; the root
// Vitest run doesn't apply that config, so stub them for the routes (e.g. "/")
// where <VersionFooter /> renders (non-full-bleed).
beforeAll(() => {
  vi.stubGlobal("__GIT_COMMIT__", "test-commit");
  vi.stubGlobal("__BUILD_TIME__", "1970-01-01T00:00:00Z");
  vi.stubGlobal("__GIT_BRANCH__", "test-branch");
  // <VersionFooter /> and <ProjectSwitcher /> fire data fetches on mount; make
  // them reject fast (handled by their own catch/react-query) so no request is
  // left pending to abort at teardown and spam the log.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("network disabled in test"))),
  );
});

function renderLayout(
  path = "/runs",
  { projectId = "proj-1" }: { projectId?: string | null } = {},
) {
  // Layout gates project-scoped nav on a selected project, so seed one by
  // default; pass { projectId: null } to exercise the no-project state.
  if (projectId) localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  // Layout now hosts <ProjectSwitcher />, which reads react-query + ProjectContext,
  // so the harness provides both (mirroring main.tsx).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <ProjectProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<div>Home page</div>} />
                <Route path="/runs" element={<div>Runs page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ProjectProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Layout", () => {
  it("expands the desktop sidebar to show navigation labels", () => {
    renderLayout();

    const sidebar = screen.getByLabelText("Primary navigation");
    expect(within(sidebar).queryByText("Activity")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(localStorage.getItem("scope:layout:sidebar-expanded")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(localStorage.getItem("scope:layout:sidebar-expanded")).toBe("1");
  });

  it("honors the stored expanded state on first render", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout();

    const sidebar = screen.getByLabelText("Primary navigation");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
  });

  it("labels the prompt library nav item 'Prompts' linking to /task-prompts", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout();

    const sidebar = screen.getByLabelText("Primary navigation");
    const promptsLink = within(sidebar).getByRole("link", { name: "Prompts" });
    expect(promptsLink.getAttribute("href")).toBe("/task-prompts");
    // The legacy "Tasks" label must be gone.
    expect(within(sidebar).queryByRole("link", { name: "Tasks" })).toBeNull();
  });

  it("shows scoped nav and the New Run CTA when a project is selected", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs");

    const sidebar = screen.getByLabelText("Primary navigation");
    // Scoped groups + the emphasized CTA are present with a project in use.
    expect(within(sidebar).getByRole("link", { name: "New Run" })).toBeTruthy();
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "MCP" })).toBeTruthy();
    // Global group is present too.
    expect(within(sidebar).getByText("Platform")).toBeTruthy();
  });

  it("hides project-scoped nav until a project is selected", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs", { projectId: null });

    const sidebar = screen.getByLabelText("Primary navigation");
    // Global entries stay reachable without a selection.
    expect(within(sidebar).getByRole("link", { name: "Projects" })).toBeTruthy();
    expect(within(sidebar).getByText("Platform")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Models" })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Secrets" })).toBeTruthy();
    // Scoped groups and their items are hidden.
    expect(within(sidebar).queryByText("Activity")).toBeNull();
    expect(within(sidebar).queryByText("Library")).toBeNull();
    expect(within(sidebar).queryByText("Resources")).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Runs" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Prompts" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "MCP" })).toBeNull();
    // The New Run CTA is scoped too, so it's gone until a project is picked.
    expect(within(sidebar).queryByRole("link", { name: "New Run" })).toBeNull();
  });

  it("clears the active project and collapses scoped nav when the logo is clicked", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs");

    const sidebar = screen.getByLabelText("Primary navigation");
    // Verify: scoped nav is present while a project is selected.
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "New Run" })).toBeTruthy();
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("proj-1");

    // Clicking the "Scope home" logo clears the selection and routes to "/".
    fireEvent.click(screen.getByRole("link", { name: "Scope home" }));

    // Selection is cleared (persisted key removed)…
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
    // …and the scoped groups collapse to the global-only nav.
    expect(within(sidebar).queryByText("Activity")).toBeNull();
    expect(within(sidebar).queryByText("Library")).toBeNull();
    expect(within(sidebar).queryByText("Resources")).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "New Run" })).toBeNull();
    // Global entries remain reachable.
    expect(within(sidebar).getByRole("link", { name: "Projects" })).toBeTruthy();
    expect(within(sidebar).getByText("Platform")).toBeTruthy();
  });

  it("keeps the active project when the logo is cmd/ctrl-clicked (open in new tab)", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs");

    const logo = screen.getByRole("link", { name: "Scope home" });
    // Modifier-clicks (open in new tab/window) must not wipe this tab's selection.
    fireEvent.click(logo, { metaKey: true });
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("proj-1");

    fireEvent.click(logo, { ctrlKey: true });
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("proj-1");

    const sidebar = screen.getByLabelText("Primary navigation");
    // Scoped nav stays put.
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
  });
});
