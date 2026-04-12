// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, isFlatCursor, isGroupCursor, type FlatCursor, type GroupCursor } from "./cursor.js";

describe("cursor encoding", () => {
  it("round-trips a flat cursor", () => {
    const cursor: FlatCursor = { c: "2025-01-15T10:00:00.000Z", i: "abc123" };
    const encoded = encodeCursor(cursor);
    expect(typeof encoded).toBe("string");
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(cursor);
    expect(isFlatCursor(decoded)).toBe(true);
    expect(isGroupCursor(decoded)).toBe(false);
  });

  it("round-trips a group cursor", () => {
    const cursor: GroupCursor = { k: "task-prompt-42" };
    const encoded = encodeCursor(cursor);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(cursor);
    expect(isGroupCursor(decoded)).toBe(true);
    expect(isFlatCursor(decoded)).toBe(false);
  });

  it("produces base64url string without padding", () => {
    const encoded = encodeCursor({ k: "x" });
    // base64url must not contain +, /, or =
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("throws on invalid base64", () => {
    expect(() => decodeCursor("!!!invalid!!!")).toThrow("Invalid cursor");
  });

  it("throws on valid base64 but wrong shape", () => {
    const bad = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    expect(() => decodeCursor(bad)).toThrow("Invalid cursor");
  });

  it("throws on valid base64 but non-JSON", () => {
    const bad = Buffer.from("not json").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow("Invalid cursor");
  });
});
