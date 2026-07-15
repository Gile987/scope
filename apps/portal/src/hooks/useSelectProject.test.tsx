// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY, getSelectedProjectId } from "@/lib/project-scope";
import { useSelectProject } from "./useSelectProject";

/**
 * Renders a tiny harness that exposes {@link useSelectProject} via a button, so
 * a test can trigger a project switch with fixed args inside `act`.
 */
function renderSelectHarness(
  queryClient: QueryClient,
  args: { projectId: string | undefined; preserveQueryKeyRoots?: readonly string[] },
) {
  function Harness() {
    const selectProject = useSelectProject();
    return (
      <button
        data-testid="select"
        onClick={() => selectProject(args.projectId, {
          preserveQueryKeyRoots: args.preserveQueryKeyRoots,
        })}
      >
        select
      </button>
    );
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        <Harness />
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useSelectProject", () => {
  beforeEach(() => localStorage.clear());

  it("updates the selection (context holder + localStorage)", () => {
    const qc = makeClient();
    const { getByTestId } = renderSelectHarness(qc, { projectId: "p-new" });

    act(() => getByTestId("select").click());

    expect(getSelectedProjectId()).toBe("p-new");
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("p-new");
  });

  it("resets scoped queries but preserves the global shell families", () => {
    const qc = makeClient();
    // Seed inactive cache entries (no observers, so reset clears without refetch).
    qc.setQueryData(["report-templates"], ["t1"]); // scoped → should reset
    qc.setQueryData(["projects"], ["p-a"]); // global → preserved
    qc.setQueryData(["feature-flags"], { tokens: true }); // global → preserved

    const { getByTestId } = renderSelectHarness(qc, { projectId: "p-new" });
    act(() => getByTestId("select").click());

    expect(qc.getQueryData(["report-templates"])).toBeUndefined();
    expect(qc.getQueryData(["projects"])).toEqual(["p-a"]);
    expect(qc.getQueryData(["feature-flags"])).toEqual({ tokens: true });
  });

  it("preserves caller-supplied query-key roots while still resetting other scoped queries", () => {
    const qc = makeClient();
    qc.setQueryData(["run", "abc"], { _id: "abc" }); // preserved by caller
    qc.setQueryData(["profile", "prof"], { id: "prof" }); // preserved by caller
    qc.setQueryData(["report-templates"], ["t1"]); // NOT preserved → resets

    const { getByTestId } = renderSelectHarness(qc, {
      projectId: "p-new",
      preserveQueryKeyRoots: ["run", "profile"],
    });
    act(() => getByTestId("select").click());

    // Preserved unscoped point-reads survive the switch (no flash on the page).
    expect(qc.getQueryData(["run", "abc"])).toEqual({ _id: "abc" });
    expect(qc.getQueryData(["profile", "prof"])).toEqual({ id: "prof" });
    // A scoped query not in the preserve list is still dropped so it refetches
    // under the newly selected project.
    expect(qc.getQueryData(["report-templates"])).toBeUndefined();
  });
});
