// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

afterEach(cleanup);

class MatchMediaController {
  public matches: boolean;
  private listeners = new Set<(e: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  media = "(max-width: 1023.98px)";
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

function QueryHarness() {
  const matches = useMediaQuery("(max-width: 1023.98px)");
  return <span data-testid="match">{matches ? "yes" : "no"}</span>;
}

describe("useMediaQuery", () => {
  it("uses the current match state on first render", () => {
    const controller = new MatchMediaController(true);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => controller,
    });

    render(<QueryHarness />);
    expect(screen.getByTestId("match").textContent).toBe("yes");
  });

  it("updates when media query match changes", async () => {
    const controller = new MatchMediaController(false);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => controller,
    });

    render(<QueryHarness />);
    expect(screen.getByTestId("match").textContent).toBe("no");

    act(() => {
      controller.dispatch(true);
    });
    await waitFor(() => expect(screen.getByTestId("match").textContent).toBe("yes"));
  });
});
