// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskPrompt } from "@/types";

const listTaskPrompts = vi.fn(
  async () => ({ items: [] as TaskPrompt[], total: 0 }),
);

vi.mock("@/lib/api", () => ({
  api: {
    listTaskPrompts: (...args: unknown[]) => listTaskPrompts(...(args as [])),
  },
}));

import { TaskPromptPicker } from "./TaskPromptPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const AGENTS_PROMPTS: TaskPrompt[] = [
  { _id: "41f57458-aaaa", text: "When creating REST APIs, use Typescript.", type: "agents.md", createdAt: "2026-01-01T00:00:00.000Z" },
  { _id: "3d9e1d0f-bbbb", text: "When creating REST APIs, use Flask.", type: "agents.md", createdAt: "2026-01-01T00:00:00.000Z" },
];

function renderPicker(onSelect = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TaskPromptPicker
        type="agents.md"
        placeholder="Search existing AGENTS.md prompts or type a new one below…"
        onSelect={onSelect}
      />
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe("TaskPromptPicker (AGENTS.md library lookup)", () => {
  it("scopes the prompt-library query to the agents.md type", async () => {
    listTaskPrompts.mockResolvedValue({ items: AGENTS_PROMPTS, total: 2 });

    renderPicker();
    fireEvent.focus(screen.getByPlaceholderText(/AGENTS\.md/));

    // Wait for the dropdown to populate from the (mocked) library.
    expect(await screen.findByText(/use Typescript/)).toBeTruthy();
    expect(listTaskPrompts).toHaveBeenCalledWith({ search: undefined, limit: 8, type: "agents.md" });
  });

  it("fills the field with the selected prompt's text on click", async () => {
    listTaskPrompts.mockResolvedValue({ items: AGENTS_PROMPTS, total: 2 });

    const { onSelect } = renderPicker();
    fireEvent.focus(screen.getByPlaceholderText(/AGENTS\.md/));

    const item = await screen.findByText(/use Typescript/);
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalledWith("When creating REST APIs, use Typescript.");
  });

  it("shows an empty-state message when the library has no matches", async () => {
    listTaskPrompts.mockResolvedValue({ items: [], total: 0 });

    renderPicker();
    fireEvent.change(screen.getByPlaceholderText(/AGENTS\.md/), { target: { value: "nope" } });

    expect(await screen.findByText(/No matching task prompts/)).toBeTruthy();
  });
});
