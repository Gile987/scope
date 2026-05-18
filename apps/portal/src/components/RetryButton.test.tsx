// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { getRetryButtonState } from "./RetryButton";

describe("getRetryButtonState", () => {
  it("enabled for failed runs without shift", () => {
    const state = getRetryButtonState(false, false, false);
    expect(state.disabled).toBe(false);
    expect(state.title).toBeUndefined();
  });

  it("disabled for successful runs without shift", () => {
    const state = getRetryButtonState(true, false, false);
    expect(state.disabled).toBe(true);
    expect(state.title).toBe("Hold Shift to force retry a successful run");
  });

  it("enabled for successful runs when shift is held", () => {
    const state = getRetryButtonState(true, false, true);
    expect(state.disabled).toBe(false);
    expect(state.title).toBeUndefined();
  });

  it("disabled when mutation is pending regardless of shift", () => {
    expect(getRetryButtonState(false, true, false).disabled).toBe(true);
    expect(getRetryButtonState(false, true, true).disabled).toBe(true);
    expect(getRetryButtonState(true, true, true).disabled).toBe(true);
  });
});
