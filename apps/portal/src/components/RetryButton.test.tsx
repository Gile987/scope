// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShiftModifier } from "../hooks/useShiftModifier";
import { getRetryButtonState } from "./RetryButton";

afterEach(cleanup);

describe("getRetryButtonState", () => {
  it("enabled for failed runs without shift", () => {
    const state = getRetryButtonState(false, false, false);
    expect(state.disabled).toBe(false);
    expect(state.title).toBeUndefined();
  });

  it("disabled for successful runs without shift", () => {
    const state = getRetryButtonState(true, false, false);
    expect(state.disabled).toBe(true);
    expect(state.title).toBe("Hold Shift to force retry a successful run");
  });

  it("enabled for successful runs when shift is held", () => {
    const state = getRetryButtonState(true, false, true);
    expect(state.disabled).toBe(false);
    expect(state.title).toBeUndefined();
  });

  it("disabled when mutation is pending regardless of shift", () => {
    expect(getRetryButtonState(false, true, false).disabled).toBe(true);
    expect(getRetryButtonState(false, true, true).disabled).toBe(true);
    expect(getRetryButtonState(true, true, true).disabled).toBe(true);
  });
});

/** Test harness that renders the hook value into the DOM */
function ShiftIndicator() {
  const shiftHeld = useShiftModifier();
  return <span data-testid="shift">{shiftHeld ? "yes" : "no"}</span>;
}

describe("useShiftModifier", () => {
  it("defaults to false", () => {
    render(<ShiftIndicator />);
    expect(screen.getByTestId("shift").textContent).toBe("no");
  });

  it("becomes true on keydown Shift", () => {
    render(<ShiftIndicator />);
    fireEvent.keyDown(window, { key: "Shift" });
    expect(screen.getByTestId("shift").textContent).toBe("yes");
  });

  it("resets on keyup Shift", () => {
    render(<ShiftIndicator />);
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.keyUp(window, { key: "Shift" });
    expect(screen.getByTestId("shift").textContent).toBe("no");
  });

  it("resets on window blur", () => {
    render(<ShiftIndicator />);
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.blur(window);
    expect(screen.getByTestId("shift").textContent).toBe("no");
  });
});
