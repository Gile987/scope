// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { TaskPrompt } from "@/types";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { getSelectedProjectId } from "@/lib/project-scope";

const getTaskPrompt = vi.fn(async () => ({}) as TaskPrompt);

vi.mock("@/lib/api", () => ({
  api: {
    getTaskPrompt: (...args: unknown[]) => getTaskPrompt(...(args as [])),
    deleteTaskPrompt: vi.fn(),
  },
}));

// The Features card fetches on its own; stub it out so the test stays focused
// on the heading/type-label behavior.
vi.mock("@/components/TaskPromptFeatures", () => ({
  TaskPromptFeatures: () => null,
}));

import { TaskPromptDetail } from "./TaskPromptDetail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectProvider>
        <MemoryRouter initialEntries={["/task-prompts/abc"]}>
          <Routes>
            <Route path="/task-prompts/:id" element={<TaskPromptDetail />} />
          </Routes>
        </MemoryRouter>
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

const basePrompt: TaskPrompt = {
  _id: "abc",
  projectId: "proj-x",
  text: "When creating REST APIs, use Typescript.",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("TaskPromptDetail heading adapts to prompt type", () => {
  it("renders 'AGENTS.md Prompt' for an agents.md prompt", async () => {
    getTaskPrompt.mockResolvedValue({ ...basePrompt, type: "agents.md" });

    renderDetail();

    expect(await screen.findByText(/AGENTS\.md Prompt/)).toBeTruthy();
    // Generic content card label (renamed from "Task Text").
    expect(screen.getByText("Prompt Text")).toBeTruthy();
    // The legacy hard-coded "Task Prompt" heading must be gone.
    expect(screen.queryByText("Task Prompt")).toBeNull();
  });

  it("renders 'Requirements Prompt' for a select gate prompt", async () => {
    getTaskPrompt.mockResolvedValue({ ...basePrompt, type: "select" });

    renderDetail();

    expect(await screen.findByText(/Requirements Prompt/)).toBeTruthy();
  });

  it("falls back to 'Requirements Prompt' for a legacy untyped prompt", async () => {
    getTaskPrompt.mockResolvedValue({ ...basePrompt, type: undefined });

    renderDetail();

    expect(await screen.findByText(/Requirements Prompt/)).toBeTruthy();
  });
});

describe("TaskPromptDetail auto-scopes to the prompt's project", () => {
  it("selects the prompt's project when the URL is opened directly", async () => {
    getTaskPrompt.mockResolvedValue({ ...basePrompt, type: "select" });

    renderDetail();

    // Once the prompt resolves, the app scopes to its owning project so the
    // shell (nav, "Back to task prompts") points at the right project.
    await waitFor(() => expect(getSelectedProjectId()).toBe("proj-x"));
  });
});
