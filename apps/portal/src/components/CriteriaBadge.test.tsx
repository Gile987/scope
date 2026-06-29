// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const getCriterion = vi.fn(async () => ({
  id: "has-tests",
  prompt: "The project must include automated tests.",
  dependents: [],
}));

vi.mock("@/lib/api", () => ({
  api: {
    getCriterion: (...args: unknown[]) => getCriterion(...(args as [])),
  },
}));

import { CriteriaBadge } from "./CriteriaBadge";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBadge(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CriteriaBadge navigation + rendering", () => {
  it("links to the criterion detail page", () => {
    renderBadge(<CriteriaBadge criterionId="has-tests" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/criteria/has-tests");
    expect(link.textContent).toContain("has-tests");
  });

  it("renders a non-linking span when link is false", () => {
    renderBadge(<CriteriaBadge criterionId="has-tests" link={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("has-tests")).toBeTruthy();
  });

  it("renders the result state label when evaluated", () => {
    renderBadge(
      <CriteriaBadge criterionId="has-tests" evaluated result={true} showStateLabel />,
    );
    expect(screen.getByText(/has-tests: /)).toBeTruthy();
  });
});

describe("CriteriaBadge lazy fetch (no request fan-out)", () => {
  it("never fetches when a prompt is supplied", async () => {
    renderBadge(<CriteriaBadge criterionId="has-tests" prompt="Preloaded prompt" />);
    await userEvent.hover(screen.getByRole("link"));
    await new Promise((r) => setTimeout(r, 50));
    expect(getCriterion).not.toHaveBeenCalled();
  });

  it("does not fetch on mount and fetches exactly once after the tooltip opens", async () => {
    renderBadge(<CriteriaBadge criterionId="has-tests" />);
    expect(getCriterion).not.toHaveBeenCalled();

    await userEvent.hover(screen.getByRole("link"));
    await waitFor(() => expect(getCriterion).toHaveBeenCalledTimes(1));
    expect(getCriterion).toHaveBeenCalledWith("has-tests");
  });
});

describe("CriteriaBadge stops row-click propagation", () => {
  it("does not bubble the click to an ancestor handler", async () => {
    const onRowClick = vi.fn();
    renderBadge(
      <div onClick={onRowClick}>
        <CriteriaBadge criterionId="has-tests" prompt="x" />
      </div>,
    );
    await userEvent.click(screen.getByRole("link"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
