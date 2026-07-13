// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import type { FeatureFlag } from "@/types";
import { useVisibleGates } from "./useVisibleGates";

const mockState: { flags: FeatureFlag[]; isLoading: boolean } = {
  flags: [],
  isLoading: false,
};

vi.mock("@/contexts/FeatureFlagContext", () => ({
  useFeatureFlags: () => ({
    flags: mockState.flags,
    isLoading: mockState.isLoading,
    isFeatureEnabled: () => true,
  }),
}));

function flag(key: string, enabled: boolean): FeatureFlag {
  return { key, label: key, enabled, updatedAt: "" };
}

beforeEach(() => {
  mockState.flags = [];
  mockState.isLoading = false;
});

afterEach(() => cleanup());

describe("useVisibleGates", () => {
  it("hides run + deploy while flags are empty/loading (fail-closed)", () => {
    mockState.flags = [];
    mockState.isLoading = true;
    const { result } = renderHook(() => useVisibleGates());
    expect(result.current).toEqual(["select", "build", "test"]);
  });

  it("shows run when gates-run is enabled", () => {
    mockState.flags = [flag("gates-run", true)];
    const { result } = renderHook(() => useVisibleGates());
    expect(result.current).toEqual(["select", "build", "test", "run"]);
  });

  it("shows deploy when gates-deploy is enabled", () => {
    mockState.flags = [flag("gates-deploy", true)];
    const { result } = renderHook(() => useVisibleGates());
    expect(result.current).toEqual(["select", "build", "test", "deploy"]);
  });

  it("shows all gates when both flags are enabled", () => {
    mockState.flags = [flag("gates-run", true), flag("gates-deploy", true)];
    const { result } = renderHook(() => useVisibleGates());
    expect(result.current).toEqual([
      "select",
      "build",
      "test",
      "run",
      "deploy",
    ]);
  });

  it("keeps run/deploy hidden when their flags are explicitly off", () => {
    mockState.flags = [flag("gates-run", false), flag("gates-deploy", false)];
    const { result } = renderHook(() => useVisibleGates());
    expect(result.current).toEqual(["select", "build", "test"]);
  });
});
