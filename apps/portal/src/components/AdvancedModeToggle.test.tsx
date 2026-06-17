// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { AdvancedModeToggle } from "./AdvancedModeToggle";

afterEach(cleanup);

describe("AdvancedModeToggle", () => {
  it("renders the default 'Advanced' label", () => {
    render(<AdvancedModeToggle checked={false} onCheckedChange={() => {}} />);
    expect(screen.getByText("Advanced")).toBeDefined();
  });

  it("renders a custom label when provided", () => {
    render(
      <AdvancedModeToggle
        checked={false}
        onCheckedChange={() => {}}
        label="Expert mode"
      />,
    );
    expect(screen.getByText("Expert mode")).toBeDefined();
  });

  it("reflects checked=false on the underlying switch", () => {
    render(<AdvancedModeToggle checked={false} onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: /toggle advanced options/i });
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects checked=true on the underlying switch", () => {
    render(<AdvancedModeToggle checked={true} onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: /toggle advanced options/i });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("calls onCheckedChange with the new value when clicked", () => {
    const onCheckedChange = vi.fn();
    render(
      <AdvancedModeToggle checked={false} onCheckedChange={onCheckedChange} />,
    );
    const sw = screen.getByRole("switch", { name: /toggle advanced options/i });
    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("calls onCheckedChange with false when toggled off", () => {
    const onCheckedChange = vi.fn();
    render(
      <AdvancedModeToggle checked={true} onCheckedChange={onCheckedChange} />,
    );
    const sw = screen.getByRole("switch", { name: /toggle advanced options/i });
    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("uses the default 'advanced-mode' id on the switch", () => {
    render(<AdvancedModeToggle checked={false} onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: /toggle advanced options/i });
    expect(sw.id).toBe("advanced-mode");
  });

  it("uses a custom id when provided and wires the label to it", () => {
    render(
      <AdvancedModeToggle
        checked={false}
        onCheckedChange={() => {}}
        id="my-toggle"
      />,
    );
    const sw = screen.getByRole("switch", { name: /toggle advanced options/i });
    expect(sw.id).toBe("my-toggle");
    const label = screen.getByText("Advanced");
    expect(label.getAttribute("for")).toBe("my-toggle");
  });

  it("renders a help tooltip trigger", () => {
    render(<AdvancedModeToggle checked={false} onCheckedChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: /more info/i }),
    ).toBeDefined();
  });

  it("applies a custom className to the pill container", () => {
    render(
      <AdvancedModeToggle
        checked={false}
        onCheckedChange={() => {}}
        className="my-extra-class"
      />,
    );
    const label = screen.getByText("Advanced");
    const pill = label.parentElement;
    expect(pill?.className).toContain("my-extra-class");
    expect(pill?.className).toContain("rounded-full");
  });
});
