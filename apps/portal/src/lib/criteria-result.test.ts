// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { criterionResultStyle } from "./criteria-result";
import { Check, X, HelpCircle } from "lucide-react";

describe("criterionResultStyle", () => {
  it("returns green styles and Check icon for true", () => {
    const result = criterionResultStyle(true);
    expect(result.Icon).toBe(Check);
    expect(result.title).toBe("Passed");
    expect(result.colorClass).toContain("green");
  });

  it("returns red styles and X icon for false", () => {
    const result = criterionResultStyle(false);
    expect(result.Icon).toBe(X);
    expect(result.title).toBe("Failed");
    expect(result.colorClass).toContain("red");
  });

  it("returns gray styles and HelpCircle icon for undefined", () => {
    const result = criterionResultStyle(undefined);
    expect(result.Icon).toBe(HelpCircle);
    expect(result.title).toBe("Not evaluated");
    expect(result.colorClass).toContain("gray");
  });
});
