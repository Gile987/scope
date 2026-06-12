// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCriteriaWizard } from "./useCriteriaWizard";

vi.mock("@/lib/api", () => ({
  api: {
    listCriteria: vi.fn().mockResolvedValue([]),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
