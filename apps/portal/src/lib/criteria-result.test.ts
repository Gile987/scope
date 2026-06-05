// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { criterionResultStyle } from "./criteria-result";

describe("criterionResultStyle", () => {
  // ── Core branches ──────────────────────────────────────────────────────────

  it("returns green pass style for true", () => {
    const style = criterionResultStyle(true);
    expect(style.label).toBe("true");
    expect(style.title).toBe("Passed");
    expect(style.colorClass).toBe(
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    );
    expect(style.Icon).toBe(CheckCircle2);
  });

  it("returns red fail style for false", () => {
    const style = criterionResultStyle(false);
    expect(style.label).toBe("false");
    expect(style.title).toBe("Failed");
    expect(style.colorClass).toBe(
      "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
    );
    expect(style.Icon).toBe(XCircle);
  });

  it("returns gray not-evaluated style for undefined", () => {
    const style = criterionResultStyle(undefined);
    expect(style.label).toBe("–");
    expect(style.title).toBe("Not evaluated");
    expect(style.colorClass).toBe(
      "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
    );
    expect(style.Icon).toBe(MinusCircle);
  });

  // ── Return shape ───────────────────────────────────────────────────────────

  it("always returns all four required fields", () => {
    for (const result of [true, false, undefined] as const) {
      const style = criterionResultStyle(result);
      expect(style).toHaveProperty("colorClass");
      expect(style).toHaveProperty("Icon");
      expect(style).toHaveProperty("label");
      expect(style).toHaveProperty("title");
    }
  });

  it("returns distinct icons for each state", () => {
    const passIcon = criterionResultStyle(true).Icon;
    const failIcon = criterionResultStyle(false).Icon;
    const skipIcon = criterionResultStyle(undefined).Icon;
    expect(passIcon).not.toBe(failIcon);
    expect(passIcon).not.toBe(skipIcon);
    expect(failIcon).not.toBe(skipIcon);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("treats null as not-evaluated (strict equality, API may return null)", () => {
    // The type accepts boolean | undefined, but JS consumers (e.g. API JSON
    // deserialisation) may produce null for an absent evaluation.  The
    // function uses === so null falls through to the default branch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style = criterionResultStyle(null as any);
    expect(style.title).toBe("Not evaluated");
    expect(style.Icon).toBe(MinusCircle);
  });

  it("treats truthy non-boolean (1) as not-evaluated due to strict equality", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style = criterionResultStyle(1 as any);
    expect(style.title).toBe("Not evaluated");
  });

  it("treats falsy non-boolean (0) as not-evaluated due to strict equality", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style = criterionResultStyle(0 as any);
    expect(style.title).toBe("Not evaluated");
  });

  it("is pure — repeated calls with the same input return structurally equal results", () => {
    expect(criterionResultStyle(true)).toEqual(criterionResultStyle(true));
    expect(criterionResultStyle(false)).toEqual(criterionResultStyle(false));
    expect(criterionResultStyle(undefined)).toEqual(criterionResultStyle(undefined));
  });
});
