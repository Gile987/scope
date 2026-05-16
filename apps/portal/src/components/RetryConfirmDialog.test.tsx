// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RetryConfirmDialog } from "./RetryConfirmDialog";

afterEach(cleanup);

describe("RetryConfirmDialog", () => {
  it("renders title and description when open", () => {
    render(
      <RetryConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        isPending={false}
      />,
    );
    expect(screen.getByText("Retry successful run?")).toBeDefined();
    expect(
      screen.getByText(
        "This run completed successfully. Are you sure you want to retry it?",
      ),
    ).toBeDefined();
  });

  it("does not render content when closed", () => {
    render(
      <RetryConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        isPending={false}
      />,
    );
    expect(screen.queryByText("Retry successful run?")).toBeNull();
  });

  it("calls onConfirm when Retry is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <RetryConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByText("Retry"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("shows 'Retrying…' and disables the button when pending", () => {
    render(
      <RetryConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        isPending={true}
      />,
    );
    const btn = screen.getByText("Retrying…");
    expect(btn).toBeDefined();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onOpenChange when Cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <RetryConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onOpenChange).toHaveBeenCalled();
  });
});
