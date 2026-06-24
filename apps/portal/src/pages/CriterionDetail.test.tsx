// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { CriteriaDocument } from "@/types";

const updateCriterion = vi.fn(async () => ({}) as CriteriaDocument);
const getCriterion = vi.fn(async () => ({
  id: "tests_pass",
  prompt: "Tests pass",
  dependsOn: ["has_90p_test_coverage"],
  gates: ["test"],
  dependents: [],
}));
const listCriteria = vi.fn(async () => [] as CriteriaDocument[]);

vi.mock("@/lib/api", () => ({
  api: {
    getCriterion: (...args: unknown[]) => getCriterion(...(args as [])),
    listCriteria: (...args: unknown[]) => listCriteria(...(args as [])),
    updateCriterion: (...args: unknown[]) => updateCriterion(...(args as [])),
    deleteCriterion: vi.fn(),
    generateCriteriaPrompt: vi.fn(),
  },
}));

import { CriterionDetail } from "./CriterionDetail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/criteria/tests_pass"]}>
        <Routes>
          <Route path="/criteria/:id" element={<CriterionDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CriterionDetail dependency removal", () => {
  // Regression: handleSave collapsed an empty dependsOn array to `undefined`,
  // and the backend treats `undefined` as "no change" — so removing the last
  // dependency silently did nothing and the dependency reappeared after save.
  it("sends an empty dependsOn array when the last dependency is removed", async () => {
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: /edit/i }));

    // The dependency chip is rendered by CriteriaPicker with an X remove icon.
    const chip = await screen.findByText("has_90p_test_coverage");
    const removeIcon = chip.querySelector("svg");
    expect(removeIcon).toBeTruthy();
    fireEvent.click(removeIcon!);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(updateCriterion).toHaveBeenCalled());
    const [, body] = updateCriterion.mock.calls[0] as unknown as [string, { dependsOn?: string[] }];
    expect(body.dependsOn).toEqual([]);
  });

  it("keeps remaining dependencies when only one of several is removed", async () => {
    getCriterion.mockResolvedValueOnce({
      id: "tests_pass",
      prompt: "Tests pass",
      dependsOn: ["dep_a", "dep_b"],
      gates: ["test"],
      dependents: [],
    });
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: /edit/i }));

    const chipA = await screen.findByText("dep_a");
    fireEvent.click(chipA.querySelector("svg")!);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(updateCriterion).toHaveBeenCalled());
    const [, body] = updateCriterion.mock.calls[0] as unknown as [string, { dependsOn?: string[] }];
    expect(body.dependsOn).toEqual(["dep_b"]);
  });
});
