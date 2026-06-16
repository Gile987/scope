// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { GateCompatibilityPicker } from "./GateCompatibilityPicker";
import { GATE_ORDER, type GateId } from "@/lib/gates";

// Enable all gate flags so the picker renders the full 5-gate grid.
vi.mock("@/contexts/FeatureFlagContext", () => ({
  useFeatureFlags: () => ({
    flags: [
      { key: "gates-run", label: "Run Gate", enabled: true, updatedAt: "" },
      { key: "gates-deploy", label: "Deploy Gate", enabled: true, updatedAt: "" },
    ],
    isLoading: false,
    isFeatureEnabled: () => true,
  }),
}));

afterEach(() => cleanup());

function Harness({
  initial,
  lockedGates,
}: {
  initial: GateId[];
  lockedGates?: GateId[];
}) {
  const [gates, setGates] = useState<GateId[] | undefined>(initial);
  return (
    <>
      <GateCompatibilityPicker value={gates} onChange={setGates} lockedGates={lockedGates} />
      <output data-testid="value">{(gates ?? []).join(",")}</output>
    </>
  );
}

function gateCheckbox(gate: GateId): HTMLElement {
  // Checkboxes render in GATE_ORDER; index maps to gate.
  const idx = GATE_ORDER.indexOf(gate);
  return screen.getAllByRole("checkbox")[idx];
}

function value(): string {
  return screen.getByTestId("value").textContent ?? "";
}

function isChecked(el: HTMLElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

describe("GateCompatibilityPicker", () => {
  it("does not render an 'All gates' shortcut", () => {
    render(<Harness initial={["select"]} />);
    expect(screen.queryByText("All gates")).toBeNull();
    // Exactly one checkbox per gate, no extra shortcut checkbox.
    expect(screen.getAllByRole("checkbox")).toHaveLength(GATE_ORDER.length);
  });

  it("toggles gates on and off", () => {
    render(<Harness initial={["select"]} />);
    fireEvent.click(gateCheckbox("build"));
    expect(value()).toBe("select,build");
    fireEvent.click(gateCheckbox("build"));
    expect(value()).toBe("select");
  });

  it("refuses to drop below one selected gate", () => {
    render(<Harness initial={["select"]} />);
    fireEvent.click(gateCheckbox("select"));
    // Still selected — selection can never be emptied.
    expect(value()).toBe("select");
    expect(isChecked(gateCheckbox("select"))).toBe(true);
  });

  it("renders locked gates checked + disabled and refuses to unselect them", () => {
    render(<Harness initial={["build", "test"]} lockedGates={["build"]} />);
    const build = gateCheckbox("build") as HTMLButtonElement;
    expect(isChecked(build)).toBe(true);
    expect(build.disabled).toBe(true);
    fireEvent.click(build);
    expect(value()).toBe("build,test");
  });

  it("shows 'Unselect all' only when there are locked gates, reducing to the locked set", () => {
    render(<Harness initial={[...GATE_ORDER]} lockedGates={["build"]} />);
    fireEvent.click(screen.getByRole("button", { name: /unselect all/i }));
    expect(value()).toBe("build");
  });

  it("hides 'Unselect all' when no gate is locked", () => {
    render(<Harness initial={["select", "build"]} />);
    expect(screen.queryByRole("button", { name: /unselect all/i })).toBeNull();
  });
});
