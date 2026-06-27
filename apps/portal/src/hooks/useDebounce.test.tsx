// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useDebounce } from "./useDebounce";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness({ delay }: { delay: number }) {
  const [value, setValue] = useState("a");
  const debounced = useDebounce(value, delay);
  return (
    <>
      <span data-testid="debounced">{debounced}</span>
      <button onClick={() => setValue("b")}>set-b</button>
      <button onClick={() => setValue("c")}>set-c</button>
    </>
  );
}

describe("useDebounce", () => {
  it("returns the initial value immediately", () => {
    render(<Harness delay={300} />);
    expect(screen.getByTestId("debounced").textContent).toBe("a");
  });

  it("defers updates until the delay elapses", () => {
    vi.useFakeTimers();
    render(<Harness delay={300} />);

    fireEvent.click(screen.getByText("set-b"));
    expect(screen.getByTestId("debounced").textContent).toBe("a");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.getByTestId("debounced").textContent).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("debounced").textContent).toBe("b");
  });

  it("collapses rapid changes and only emits the latest value", () => {
    vi.useFakeTimers();
    render(<Harness delay={300} />);

    fireEvent.click(screen.getByText("set-b"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // A second change before the delay elapses resets the timer.
    fireEvent.click(screen.getByText("set-c"));
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.getByTestId("debounced").textContent).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("debounced").textContent).toBe("c");
  });
});
