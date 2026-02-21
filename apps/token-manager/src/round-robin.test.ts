// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { RoundRobinSelector, RoundRobinMap } from "./round-robin.js";

describe("RoundRobinSelector", () => {
  it("cycles through items in order", () => {
    const selector = new RoundRobinSelector<string>();
    const items = ["a", "b", "c"];

    expect(selector.next(items)).toBe("a");
    expect(selector.next(items)).toBe("b");
    expect(selector.next(items)).toBe("c");
    expect(selector.next(items)).toBe("a");
    expect(selector.next(items)).toBe("b");
    expect(selector.next(items)).toBe("c");
  });

  it("returns each item equally over multiple cycles", () => {
    const selector = new RoundRobinSelector<number>();
    const items = [1, 2, 3];
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };

    for (let i = 0; i < 9; i++) {
      const item = selector.next(items);
      counts[item]++;
    }

    expect(counts[1]).toBe(3);
    expect(counts[2]).toBe(3);
    expect(counts[3]).toBe(3);
  });

  it("always returns the same item for single-element array", () => {
    const selector = new RoundRobinSelector<string>();
    const items = ["only"];

    for (let i = 0; i < 5; i++) {
      expect(selector.next(items)).toBe("only");
    }
  });

  it("throws for empty array", () => {
    const selector = new RoundRobinSelector<string>();
    expect(() => selector.next([])).toThrow(/Cannot select from empty array/);
  });

  it("wraps correctly when array size shrinks", () => {
    const selector = new RoundRobinSelector<string>();

    // Start with 3 items, advance counter to 2
    selector.next(["a", "b", "c"]); // counter=1, returns "a"
    selector.next(["a", "b", "c"]); // counter=2, returns "b"

    // Shrink to 2 items — counter=2, 2%2=0 → "x"
    expect(selector.next(["x", "y"])).toBe("x");
    // counter=3, 3%2=1 → "y"
    expect(selector.next(["x", "y"])).toBe("y");
  });

  it("wraps correctly when array size grows", () => {
    const selector = new RoundRobinSelector<string>();

    // Start with 2 items
    selector.next(["a", "b"]); // counter=1, returns "a"
    selector.next(["a", "b"]); // counter=2, returns "b"

    // Grow to 4 items — counter=2, 2%4=2 → "c"
    expect(selector.next(["a", "b", "c", "d"])).toBe("c");
  });
});

describe("RoundRobinMap", () => {
  it("maintains independent counters per key", () => {
    const map = new RoundRobinMap<string>();

    expect(map.next("key1", ["a", "b"])).toBe("a");
    expect(map.next("key2", ["x", "y"])).toBe("x");
    expect(map.next("key1", ["a", "b"])).toBe("b");
    expect(map.next("key2", ["x", "y"])).toBe("y");
  });

  it("creates new selector for unseen key", () => {
    const map = new RoundRobinMap<number>();

    expect(map.next("new-key", [10, 20, 30])).toBe(10);
    expect(map.next("new-key", [10, 20, 30])).toBe(20);
  });

  it("throws for empty items", () => {
    const map = new RoundRobinMap<string>();
    expect(() => map.next("key", [])).toThrow(/Cannot select from empty array/);
  });
});
