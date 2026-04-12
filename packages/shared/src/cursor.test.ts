// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { encodeFlatCursor, decodeFlatCursor, encodeGroupCursor, decodeGroupCursor } from "./cursor.js";

describe("flat cursor", () => {
  it("round-trips", () => {
    const encoded = encodeFlatCursor("2025-01-15T10:00:00.000Z", "abc123");
    expect(encoded).toBe("createdAt~2025-01-15T10:00:00.000Z|id~abc123");
    const decoded = decodeFlatCursor(encoded);
    expect(decoded).toEqual({ createdAt: "2025-01-15T10:00:00.000Z", id: "abc123" });
  });

  it("throws on missing pipe separator", () => {
    expect(() => decodeFlatCursor("createdAt~2025-01-15T10:00:00.000Z")).toThrow("expected 2 parts");
  });

  it("throws on wrong field name", () => {
    expect(() => decodeFlatCursor("foo~bar|id~abc")).toThrow("expected 'createdAt'");
  });

  it("throws on missing tilde", () => {
    expect(() => decodeFlatCursor("no-tilde|id~abc")).toThrow("missing '~'");
  });
});

describe("group cursor", () => {
  it("round-trips with taskPromptId", () => {
    const encoded = encodeGroupCursor("taskPromptId", "tp-calculator-v2");
    expect(encoded).toBe("taskPromptId~tp-calculator-v2");
    const decoded = decodeGroupCursor(encoded);
    expect(decoded).toEqual({ field: "taskPromptId", value: "tp-calculator-v2" });
  });

  it("round-trips with submissionId", () => {
    const encoded = encodeGroupCursor("submissionId", "sub-20250115-001");
    expect(encoded).toBe("submissionId~sub-20250115-001");
    const decoded = decodeGroupCursor(encoded);
    expect(decoded).toEqual({ field: "submissionId", value: "sub-20250115-001" });
  });

  it("handles values containing colons", () => {
    const encoded = encodeGroupCursor("submissionId", "sub:with:colons");
    const decoded = decodeGroupCursor(encoded);
    expect(decoded).toEqual({ field: "submissionId", value: "sub:with:colons" });
  });

  it("throws on missing tilde", () => {
    expect(() => decodeGroupCursor("notilde")).toThrow("missing '~'");
  });
});
