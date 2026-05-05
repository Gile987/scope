// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { criterionResultStyle } from "./criteria-result";

describe("criterionResultStyle", () => {
  it("returns green pass style for true", () => {
    const style = criterionResultStyle(true);
    expect(style.label).toBe("true");
    expect(style.title).toBe("Passed");
    expect(style.colorClass).toContain("emerald");
    expect(style.Icon).toBeDefined();
  });

  it("returns red fail style for false", () => {
    const style = criterionResultStyle(false);
    expect(style.label).toBe("false");
    expect(style.title).toBe("Failed");
    expect(style.colorClass).toContain("red");
    expect(style.Icon).toBeDefined();
  });

  it("returns gray not-evaluated style for undefined", () => {
    const style = criterionResultStyle(undefined);
    expect(style.label).toBe("–");
    expect(style.title).toBe("Not evaluated");
    expect(style.colorClass).toContain("muted");
    expect(style.Icon).toBeDefined();
  });

  it("returns distinct icons for each state", () => {
    const passIcon = criterionResultStyle(true).Icon;
    const failIcon = criterionResultStyle(false).Icon;
    const skipIcon = criterionResultStyle(undefined).Icon;
    expect(passIcon).not.toBe(failIcon);
    expect(passIcon).not.toBe(skipIcon);
    expect(failIcon).not.toBe(skipIcon);
  });
});
