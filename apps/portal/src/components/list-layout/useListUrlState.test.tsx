// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useListUrlState } from "./useListUrlState";

afterEach(cleanup);

function UrlStateHarness() {
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: ["worker", "status"] });
  const location = useLocation();

  return (
    <div>
      <span data-testid="search">{state.search}</span>
      <span data-testid="sort">{state.sort ?? "none"}</span>
      <span data-testid="dir">{state.sortDir}</span>
      <span data-testid="worker">{state.getFilter("worker") ?? "none"}</span>
      <span data-testid="status-list">{state.getFilterList("status").join("|") || "none"}</span>
      <span data-testid="active">{state.hasActiveFilters ? "yes" : "no"}</span>
      <span data-testid="url">{location.search}</span>

      <button onClick={() => state.toggleSort("created")}>toggle-sort</button>
      <button onClick={() => state.setSearch("foo")}>search</button>
      <button onClick={() => state.setFilter("worker", "coder-acp-copilot")}>set-worker</button>
      <button onClick={() => state.toggleFilterValue("status", "queued")}>toggle-status</button>
      <button onClick={() => state.clearFilters()}>clear-filters</button>
    </div>
  );
}

describe("useListUrlState", () => {
  it("cycles sort state (asc -> desc -> none)", () => {
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <UrlStateHarness />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("sort").textContent).toBe("none");

    fireEvent.click(screen.getByText("toggle-sort"));
    expect(screen.getByTestId("sort").textContent).toBe("created");
    expect(screen.getByTestId("dir").textContent).toBe("asc");

    fireEvent.click(screen.getByText("toggle-sort"));
    expect(screen.getByTestId("sort").textContent).toBe("created");
    expect(screen.getByTestId("dir").textContent).toBe("desc");

    fireEvent.click(screen.getByText("toggle-sort"));
    expect(screen.getByTestId("sort").textContent).toBe("none");
    expect(screen.getByTestId("dir").textContent).toBe("asc");
  });

  it("manages URL-backed filters and clears only filter/search params", () => {
    render(
      <MemoryRouter initialEntries={["/runs?page=2&size=50"]}>
        <UrlStateHarness />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("search"));
    fireEvent.click(screen.getByText("set-worker"));
    fireEvent.click(screen.getByText("toggle-status"));

    expect(screen.getByTestId("search").textContent).toBe("foo");
    expect(screen.getByTestId("worker").textContent).toBe("coder-acp-copilot");
    expect(screen.getByTestId("status-list").textContent).toBe("queued");
    expect(screen.getByTestId("active").textContent).toBe("yes");
    expect(screen.getByTestId("url").textContent).toContain("size=50");
    expect(screen.getByTestId("url").textContent).not.toContain("page=2");

    fireEvent.click(screen.getByText("clear-filters"));
    expect(screen.getByTestId("search").textContent).toBe("");
    expect(screen.getByTestId("worker").textContent).toBe("none");
    expect(screen.getByTestId("status-list").textContent).toBe("none");
    expect(screen.getByTestId("url").textContent).toContain("size=50");
  });
});

