// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AdvancedSection } from "./AdvancedSection";

afterEach(cleanup);

describe("AdvancedSection", () => {
  it("renders nothing when show is false", () => {
    render(
      <AdvancedSection show={false}>
        <div data-testid="content">Advanced content</div>
      </AdvancedSection>
    );
    
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("renders children when show is true", () => {
    render(
      <AdvancedSection show={true}>
        <div data-testid="content">Advanced content</div>
      </AdvancedSection>
    );
    
    expect(screen.getByTestId("content").textContent).toBe("Advanced content");
  });

  it("renders default label 'Advanced' when no label is provided", () => {
    render(
      <AdvancedSection show={true}>
        <div>Content</div>
      </AdvancedSection>
    );
    
    expect(screen.getByText("Advanced")).toBeDefined();
  });

  it("renders custom label when provided", () => {
    render(
      <AdvancedSection show={true} label="Expert Settings">
        <div>Content</div>
      </AdvancedSection>
    );
    
    expect(screen.getByText("Expert Settings")).toBeDefined();
  });

  it("applies custom className", () => {
    render(
      <AdvancedSection show={true} className="custom-class">
        <div data-testid="content">Content</div>
      </AdvancedSection>
    );
    
    const container = screen.getByTestId("content").parentElement;
    expect(container?.className).toContain("custom-class");
  });

  it("includes Settings2 icon in the header", () => {
    const { container } = render(
      <AdvancedSection show={true}>
        <div>Content</div>
      </AdvancedSection>
    );
    
    // The Settings2 icon has aria-hidden="true"
    const icon = container.querySelector('[aria-hidden="true"]');
    expect(icon).toBeDefined();
  });

  it("applies border and spacing classes for visual separation", () => {
    render(
      <AdvancedSection show={true}>
        <div data-testid="content">Content</div>
      </AdvancedSection>
    );
    
    const container = screen.getByTestId("content").parentElement;
    expect(container?.className).toContain("border-t");
    expect(container?.className).toContain("pt-3.5");
  });

  it("renders multiple children correctly", () => {
    render(
      <AdvancedSection show={true}>
        <div data-testid="field1">Field 1</div>
        <div data-testid="field2">Field 2</div>
        <div data-testid="field3">Field 3</div>
      </AdvancedSection>
    );
    
    expect(screen.getByTestId("field1").textContent).toBe("Field 1");
    expect(screen.getByTestId("field2").textContent).toBe("Field 2");
    expect(screen.getByTestId("field3").textContent).toBe("Field 3");
  });

  it("toggles visibility when show prop changes", () => {
    const { rerender } = render(
      <AdvancedSection show={false}>
        <div data-testid="content">Content</div>
      </AdvancedSection>
    );
    
    expect(screen.queryByTestId("content")).toBeNull();
    
    rerender(
      <AdvancedSection show={true}>
        <div data-testid="content">Content</div>
      </AdvancedSection>
    );
    
    expect(screen.getByTestId("content").textContent).toBe("Content");
  });
});
