// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCriteriaWizard } from "./useCriteriaWizard";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    listCriteria: vi.fn().mockResolvedValue([]),
    generateCriteriaPrompt: vi.fn().mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
    }),
  },
}));

const listCriteria = vi.mocked(api.listCriteria);
const generateCriteriaPrompt = vi.mocked(api.generateCriteriaPrompt);

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  listCriteria.mockResolvedValue([]);
});

describe("useCriteriaWizard initial gates", () => {
  it("defaults gate compatibility to ['select'] when initialGates is omitted", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.gates).toEqual(["select"]);
  });

  it("honours initialGates when provided", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.gates).toEqual(["build"]);
  });

  it("surfaces lockedGates in wizard state", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ lockedGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.lockedGates).toEqual(["build"]);
  });

  it("leaves lockedGates undefined when not provided", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.lockedGates).toBeUndefined();
  });
});

describe("useCriteriaWizard generation passes target gates", () => {
  afterEach(() => {
    generateCriteriaPrompt.mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
    });
  });

  it("sends the current gates on initial generation (handleContinue)", async () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );

    act(() => result.current.handleBehaviorChange("detect docker"));
    act(() => result.current.handleContinue());

    await waitFor(() =>
      expect(generateCriteriaPrompt).toHaveBeenCalledWith("detect docker", undefined, ["build"]),
    );
  });

  it("sends gates chosen in Step 1 (setGates before handleContinue)", async () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );

    act(() => result.current.handleBehaviorChange("detect docker"));
    act(() => result.current.setGates(["select", "build", "test"]));
    act(() => result.current.handleContinue());

    await waitFor(() =>
      expect(generateCriteriaPrompt).toHaveBeenCalledWith("detect docker", undefined, [
        "select",
        "build",
        "test",
      ]),
    );
  });

  it("sends the Step-2 gate choices on regenerate (handleRegenerate)", async () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );

    act(() => result.current.handleBehaviorChange("detect docker"));
    act(() => result.current.setGates(["select", "build", "test"]));
    act(() => result.current.handleRegenerate());

    await waitFor(() =>
      expect(generateCriteriaPrompt).toHaveBeenCalledWith("detect docker", undefined, [
        "select",
        "build",
        "test",
      ]),
    );
  });
});

describe("useCriteriaWizard gate-compatibility pruning", () => {
  it("prunes a pre-selected parent incompatible with the chosen gates", async () => {
    // Parent applies only to 'select'; the new criterion applies to 'build', so the
    // parent does not cover every gate of its dependent → must be dropped.
    listCriteria.mockResolvedValue([
      { id: "parent_select", prompt: "p", gates: ["select"], createdAt: "" },
    ]);
    const { result } = renderHook(
      () =>
        useCriteriaWizard({
          initialDependsOn: ["parent_select"],
          initialGates: ["build"],
          onSuccess: () => {},
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.dependsOn).toEqual([]));
  });

  it("keeps a pre-selected parent compatible with the chosen gates", async () => {
    // Parent covers both 'build' and 'test' → compatible with a 'build' dependent.
    listCriteria.mockResolvedValue([
      { id: "parent_wide", prompt: "p", gates: ["build", "test"], createdAt: "" },
      { id: "parent_universal", prompt: "p", createdAt: "" },
    ]);
    const { result } = renderHook(
      () =>
        useCriteriaWizard({
          initialDependsOn: ["parent_wide", "parent_universal"],
          initialGates: ["build"],
          onSuccess: () => {},
        }),
      { wrapper },
    );
    // Allow the criteria query to resolve, then assert both parents survive.
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current.dependsOn).toEqual(["parent_wide", "parent_universal"]);
  });

  it("prunes a selected child when gates narrow to be incompatible", async () => {
    // Child applies to 'select'. While the criterion covers 'select' the child is a
    // valid subset; narrowing the criterion to 'build' alone makes it incompatible.
    listCriteria.mockResolvedValue([
      { id: "child_select", prompt: "c", gates: ["select"], createdAt: "" },
    ]);
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["select"], onSuccess: () => {} }),
      { wrapper },
    );
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    act(() => result.current.setAcceptedChildren(["child_select"]));
    expect(result.current.acceptedChildren).toEqual(["child_select"]);

    act(() => result.current.setGates(["build"]));
    await waitFor(() => expect(result.current.acceptedChildren).toEqual([]));
  });
});
