// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShiftModifier } from "./useShiftModifier";

afterEach(cleanup);

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
