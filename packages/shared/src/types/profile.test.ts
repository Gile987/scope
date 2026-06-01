// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseProfileSpec } from "./profile.js";

describe("parseProfileSpec", () => {
  it("parses a bare profileId as no version", () => {
    expect(parseProfileSpec("abc-123")).toEqual({ profileId: "abc-123" });
  });

  it("parses profileId@N as a pinned version", () => {
    expect(parseProfileSpec("abc-123@3")).toEqual({ profileId: "abc-123", version: 3 });
  });

  it("treats a leading @ as part of the id (no version pin)", () => {
    expect(parseProfileSpec("@scope-only")).toEqual({ profileId: "@scope-only" });
  });

  it("uses the last @ to split when the id itself contains an @", () => {
    expect(parseProfileSpec("ns@scoped-id@2")).toEqual({ profileId: "ns@scoped-id", version: 2 });
  });

  it("rejects non-integer versions", () => {
    expect(() => parseProfileSpec("abc-123@1.2")).toThrow(/positive integer/);
    expect(() => parseProfileSpec("abc-123@latest")).toThrow(/positive integer/);
  });

  it("rejects zero or negative versions", () => {
    expect(() => parseProfileSpec("abc-123@0")).toThrow(/positive integer/);
    expect(() => parseProfileSpec("abc-123@-1")).toThrow(/positive integer/);
  });
});
