// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { encodeQsValue, qs } from "./url";

describe("encodeQsValue", () => {
  it("passes through unreserved and cursor chars", () => {
    expect(encodeQsValue("createdAt~2025-01-15T10:00:00.000Z|id~abc123")).toBe(
      "createdAt~2025-01-15T10:00:00.000Z|id~abc123",
    );
  });

  it("encodes &", () => {
    expect(encodeQsValue("a&b")).toBe("a%26b");
  });

  it("encodes =", () => {
    expect(encodeQsValue("a=b")).toBe("a%3Db");
  });

  it("encodes #", () => {
    expect(encodeQsValue("a#b")).toBe("a%23b");
  });

  it("encodes +", () => {
    expect(encodeQsValue("a+b")).toBe("a%2Bb");
  });

  it("encodes spaces", () => {
    expect(encodeQsValue("a b")).toBe("a%20b");
  });

  it("encodes %", () => {
    expect(encodeQsValue("100%")).toBe("100%25");
  });
});

describe("qs", () => {
  it("returns empty string for no params", () => {
    expect(qs({})).toBe("");
  });

  it("skips undefined values", () => {
    expect(qs({ a: "1", b: undefined, c: "3" })).toBe("?a=1&c=3");
  });

  it("builds query string with cursor value", () => {
    expect(qs({ limit: "10", after: "createdAt~2025-01-15T10:00:00.000Z|id~abc" })).toBe(
      "?limit=10&after=createdAt~2025-01-15T10:00:00.000Z|id~abc",
    );
  });
});
