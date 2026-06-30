// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { Layout } from "./Layout";

function renderLayout(path = "/runs") {
  return render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/runs" element={<div>Runs page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
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
});
