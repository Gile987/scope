// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProjectProvider } from "@/contexts/ProjectContext";
import { ProjectSwitcherLockProvider } from "@/contexts/ProjectSwitcherLockContext";
import { LockProjectSwitcher } from "@/components/LockProjectSwitcher";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import type { Project } from "@/types";
import { ProjectSwitcher } from "./ProjectSwitcher";

// The container calls `api.listProjects()` directly; mock the module so each
// test controls the returned list (and can reject it).
vi.mock("@/lib/api", () => ({
  api: { listProjects: vi.fn() },
}));

import { api } from "@/lib/api";

const listProjects = vi.mocked(api.listProjects);

function project(id: string, name: string): Project {
  return { _id: id, id, name } as Project;
}

function renderSwitcher(storedProjectId?: string) {
  if (storedProjectId) localStorage.setItem(PROJECT_STORAGE_KEY, storedProjectId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        <MemoryRouter>
          <ProjectSwitcher />
        </MemoryRouter>
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

/** Renders the switcher wrapped as a detail page does: lock provider + wrapper. */
function renderLockedSwitcher(storedProjectId?: string) {
  if (storedProjectId) localStorage.setItem(PROJECT_STORAGE_KEY, storedProjectId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        <ProjectSwitcherLockProvider>
          <MemoryRouter>
            <LockProjectSwitcher>
              <ProjectSwitcher />
            </LockProjectSwitcher>
          </MemoryRouter>
        </ProjectSwitcherLockProvider>
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("ProjectSwitcher self-heal", () => {
  beforeEach(() => {
    listProjects.mockReset();
  });

  it("clears a stale selection whose id is absent from the loaded list", async () => {
    // The persisted id points at a project that no longer exists (deleted in
    // another tab, or the DB was reset) — the list resolves without it.
    listProjects.mockResolvedValue([project("p-alpha", "Alpha")]);

    renderSwitcher("ghost-id");

    // Once the list loads, the ghost selection is cleared: the trigger falls
    // back to "Select project" (not "Unknown project") and localStorage is wiped
    // so scoped pages stop sending a dead projectId.
    await waitFor(() => expect(screen.getByText("Select project")).toBeTruthy());
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText("Unknown project")).toBeNull();
  });

  it("keeps a valid selection that is present in the loaded list", async () => {
    listProjects.mockResolvedValue([
      project("p-alpha", "Alpha"),
      project("p-bravo", "Bravo"),
    ]);

    renderSwitcher("p-bravo");

    // The active project's name shows in the trigger and the selection persists.
    await waitFor(() => expect(screen.getByText("Bravo")).toBeTruthy());
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("p-bravo");
  });

  it("does not clear the selection when the list fetch fails", async () => {
    // A failed (or in-flight) fetch must never be treated as "project gone".
    listProjects.mockRejectedValue(new Error("network down"));

    renderSwitcher("p-alpha");

    // The query settles into an error state; the selection is preserved.
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Unknown project")).toBeTruthy());
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("p-alpha");
  });
});

describe("ProjectSwitcher locked (detail pages)", () => {
  beforeEach(() => {
    listProjects.mockReset();
  });

  it("renders a non-interactive label when a detail page locks the switcher", async () => {
    listProjects.mockResolvedValue([
      project("p-alpha", "Alpha"),
      project("p-bravo", "Bravo"),
    ]);

    renderLockedSwitcher("p-bravo");

    // The active project is shown for context...
    await waitFor(() => expect(screen.getByText("Bravo")).toBeTruthy());
    // ...but there is no interactive switcher button (no dropdown to open).
    expect(screen.queryByRole("button", { name: /switch project/i })).toBeNull();
    expect(
      screen.getByLabelText(/current project/i).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("stays interactive while locked when no project is selected (avoids stranding)", async () => {
    // A detail page opened cold with no selection must not trap the user: the
    // lock only engages once a project is actually selected.
    listProjects.mockResolvedValue([project("p-alpha", "Alpha")]);

    renderLockedSwitcher(undefined);

    // The interactive switch button remains so the user can still pick a project.
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /switch project/i })).toBeTruthy();
  });
});
