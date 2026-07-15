// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoScopeProject } from "./useAutoScopeProject";

// Isolate the hook's decision logic: mock its two collaborators so we can assert
// exactly when (and with what) it switches the active project.
let currentSelectedProjectId: string | undefined;
const selectProject = vi.fn();

vi.mock("@/contexts/ProjectContext", () => ({
  useSelectedProjectId: () => currentSelectedProjectId,
}));
vi.mock("@/hooks/useSelectProject", () => ({
  useSelectProject: () => selectProject,
}));

const PRESERVE = ["run", "profile"] as const;

function Harness({
  resourceId,
  resourceProjectId,
}: {
  resourceId: string | undefined;
  resourceProjectId: string | undefined;
}) {
  useAutoScopeProject(resourceId, resourceProjectId, PRESERVE);
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  currentSelectedProjectId = undefined;
  selectProject.mockReset();
});

describe("useAutoScopeProject", () => {
  it("selects the resource's project (forwarding preserve roots) when none is selected", () => {
    render(<Harness resourceId="r1" resourceProjectId="p-a" />);

    expect(selectProject).toHaveBeenCalledTimes(1);
    expect(selectProject).toHaveBeenCalledWith("p-a", {
      preserveQueryKeyRoots: PRESERVE,
    });
  });

  it("switches even when a different project is already selected", () => {
    currentSelectedProjectId = "p-other";
    render(<Harness resourceId="r1" resourceProjectId="p-a" />);

    expect(selectProject).toHaveBeenCalledWith("p-a", {
      preserveQueryKeyRoots: PRESERVE,
    });
  });

  it("does nothing when the resource already matches the selection", () => {
    currentSelectedProjectId = "p-a";
    render(<Harness resourceId="r1" resourceProjectId="p-a" />);

    expect(selectProject).not.toHaveBeenCalled();
  });

  it("no-ops until the resource's project id is known", () => {
    const { rerender } = render(
      <Harness resourceId="r1" resourceProjectId={undefined} />,
    );
    expect(selectProject).not.toHaveBeenCalled();

    // Project id arrives once the run query resolves.
    rerender(<Harness resourceId="r1" resourceProjectId="p-a" />);
    expect(selectProject).toHaveBeenCalledTimes(1);
    expect(selectProject).toHaveBeenCalledWith("p-a", {
      preserveQueryKeyRoots: PRESERVE,
    });
  });

  it("selects only once per resource id, even if the selection is later cleared", () => {
    const { rerender } = render(
      <Harness resourceId="r1" resourceProjectId="p-a" />,
    );
    expect(selectProject).toHaveBeenCalledTimes(1);

    // Simulate ProjectSwitcher's self-heal clearing an unknown project: the hook
    // must NOT re-select (which would loop) because it already handled "r1".
    currentSelectedProjectId = undefined;
    rerender(<Harness resourceId="r1" resourceProjectId="p-a" />);
    expect(selectProject).toHaveBeenCalledTimes(1);
  });

  it("re-selects when navigating to a different resource id", () => {
    const { rerender } = render(
      <Harness resourceId="r1" resourceProjectId="p-a" />,
    );
    expect(selectProject).toHaveBeenCalledTimes(1);

    currentSelectedProjectId = "p-a"; // now scoped to r1's project
    rerender(<Harness resourceId="r2" resourceProjectId="p-b" />);
    expect(selectProject).toHaveBeenCalledTimes(2);
    expect(selectProject).toHaveBeenLastCalledWith("p-b", {
      preserveQueryKeyRoots: PRESERVE,
    });
  });
});
