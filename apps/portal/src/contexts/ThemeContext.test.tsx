// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

class ThemeMediaController {
  public matches: boolean;
  private listeners = new Set<(e: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  media = "(prefers-color-scheme: dark)";
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;

  addEventListener = (_: string, listener: (e: MediaQueryListEvent) => void) => {
    this.listeners.add(listener);
  };
  removeEventListener = (_: string, listener: (e: MediaQueryListEvent) => void) => {
    this.listeners.delete(listener);
  };

  dispatch(next: boolean) {
    this.matches = next;
    const event = { matches: next } as MediaQueryListEvent;
    for (const listener of this.listeners) listener(event);
  }
}

function ThemeHarness() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

describe("ThemeProvider/useTheme", () => {
  it("applies system theme resolution and reacts to system changes", async () => {
    const controller = new ThemeMediaController(true);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => controller,
    });

    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => {
      controller.dispatch(false);
    });
    await waitFor(() => expect(screen.getByTestId("resolved").textContent).toBe("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("persists user-selected theme and applies class immediately", () => {
    const controller = new ThemeMediaController(false);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => controller,
    });

    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByText("dark"));
    expect(localStorage.getItem("scope:theme")).toBe("dark");
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
