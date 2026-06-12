// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListLayout } from "./ListLayout";

vi.mock("@/hooks/useMediaQuery", () => ({
  useIsCompactViewport: () => false,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ListLayout", () => {
  it("renders title/children and persists rail collapse", () => {
    render(
      <ListLayout
        title="Runs"
        description="Run list"
        filterRail={<div>filters</div>}
        railStorageKey="runs"
      >
        <div>table-content</div>
      </ListLayout>,
    );

    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("table-content")).toBeTruthy();
    expect(localStorage.getItem("scope:list-layout:runs:rail-collapsed")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Hide filters" }));
    expect(localStorage.getItem("scope:list-layout:runs:rail-collapsed")).toBe("1");
  });

  it("honors stored collapsed state on first render", () => {
    localStorage.setItem("scope:list-layout:runs:rail-collapsed", "1");

    render(
      <ListLayout
        title="Runs"
        filterRail={<div>filters</div>}
        railStorageKey="runs"
      >
        <div>table-content</div>
      </ListLayout>,
    );

    expect(screen.getByRole("button", { name: "Show filters" })).toBeTruthy();
  });
});

