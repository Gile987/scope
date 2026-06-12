// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function setupResizeObserver() {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
}

interface Row {
  id: string;
  name: string;
}

const items: Row[] = [
  { id: "r1", name: "Alpha" },
  { id: "r2", name: "Beta" },
];

const columns: DataTableColumn<Row>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    cell: (row) => row.name,
  },
  {
    id: "hidden",
    header: "Hidden",
    hidden: true,
    cell: () => "hidden",
  },
];

describe("DataTable", () => {
  it("renders visible columns and triggers sorting", () => {
    setupResizeObserver();
    const onSortChange = vi.fn();

    render(
      <DataTable
        items={items}
        columns={columns}
        getRowId={(r) => r.id}
        sort={null}
        onSortChange={onSortChange}
      />,
    );

    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /name/i }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it("supports row selection and select-all", () => {
    setupResizeObserver();
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();

    render(
      <DataTable
        items={items}
        columns={columns}
        getRowId={(r) => r.id}
        selection={{
          selectedIds: new Set(),
          onToggle,
          onToggleAll,
        }}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    expect(onToggleAll).toHaveBeenCalledWith(["r1", "r2"], items);

    fireEvent.click(checkboxes[1]);
    expect(onToggle).toHaveBeenCalledWith("r1", items[0]);
  });
});
