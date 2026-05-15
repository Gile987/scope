// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { getRunDetailActiveTab } from "./run-detail-tab";

describe("getRunDetailActiveTab", () => {
  it("uses the route tab when present", () => {
    expect(getRunDetailActiveTab("logs", { status: "processing", turns: [{ iteration: 1, messages: [] }] })).toBe("logs");
  });

  it("defaults to logs when there are no turns", () => {
    expect(getRunDetailActiveTab(undefined, { status: "processing", turns: [] })).toBe("logs");
  });

  it("stays on logs while run is still in progress", () => {
    expect(getRunDetailActiveTab(undefined, { status: "processing", turns: [{ iteration: 1, messages: [] }] })).toBe("logs");
  });

  it("defaults to turns only after run completion", () => {
    expect(getRunDetailActiveTab(undefined, { status: "done", turns: [{ iteration: 1, messages: [] }] })).toBe("turns");
  });
});
