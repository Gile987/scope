// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAdvancedMode } from "./useAdvancedMode";

afterEach(cleanup);

function AdvancedModeHarness() {
  const [advanced, setAdvanced] = useAdvancedMode();
  return (
    <div>
      <span data-testid="value">{advanced ? "on" : "off"}</span>
      <button data-testid="enable" onClick={() => setAdvanced(true)}>
        Enable
      </button>
      <button data-testid="disable" onClick={() => setAdvanced(false)}>
        Disable
      </button>
    </div>
  );
}

describe("useAdvancedMode", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  it("defaults to false when no value is stored", () => {
    render(<AdvancedModeHarness />);
    expect(screen.getByTestId("value").textContent).toBe("off");
  });

  it("reads initial value from localStorage", () => {
    localStorage.setItem("scope:submit-run:advanced", "true");
    render(<AdvancedModeHarness />);
    expect(screen.getByTestId("value").textContent).toBe("on");
  });

  it("persists true to localStorage when enabled", () => {
    render(<AdvancedModeHarness />);
    
    act(() => {
      screen.getByTestId("enable").click();
    });
    
    expect(screen.getByTestId("value").textContent).toBe("on");
    expect(localStorage.getItem("scope:submit-run:advanced")).toBe("true");
  });

  it("persists false to localStorage when disabled", () => {
    localStorage.setItem("scope:submit-run:advanced", "true");
    render(<AdvancedModeHarness />);
    
    act(() => {
      screen.getByTestId("disable").click();
    });
    
    expect(screen.getByTestId("value").textContent).toBe("off");
    expect(localStorage.getItem("scope:submit-run:advanced")).toBe("false");
  });

  it("treats invalid localStorage values as false", () => {
    localStorage.setItem("scope:submit-run:advanced", "invalid");
    render(<AdvancedModeHarness />);
    expect(screen.getByTestId("value").textContent).toBe("off");
  });

  it("handles localStorage read failures gracefully", () => {
    // Mock localStorage.getItem to throw
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("Storage unavailable");
    };

    render(<AdvancedModeHarness />);
    expect(screen.getByTestId("value").textContent).toBe("off");

    // Restore
    Storage.prototype.getItem = original;
  });

  it("handles localStorage write failures gracefully", () => {
    // Mock localStorage.setItem to throw
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("Storage quota exceeded");
    };

    render(<AdvancedModeHarness />);
    
    // State should still update in memory even if persistence fails
    act(() => {
      screen.getByTestId("enable").click();
    });
    
    expect(screen.getByTestId("value").textContent).toBe("on");

    // Restore
    Storage.prototype.setItem = original;
  });

  it("maintains state across multiple toggles", () => {
    render(<AdvancedModeHarness />);
    
    act(() => {
      screen.getByTestId("enable").click();
    });
    expect(screen.getByTestId("value").textContent).toBe("on");
    
    act(() => {
      screen.getByTestId("disable").click();
    });
    expect(screen.getByTestId("value").textContent).toBe("off");
    
    act(() => {
      screen.getByTestId("enable").click();
    });
    expect(screen.getByTestId("value").textContent).toBe("on");
    expect(localStorage.getItem("scope:submit-run:advanced")).toBe("true");
  });
});
