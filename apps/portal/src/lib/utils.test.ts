// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { truncate, formatId, slugify, formatDuration } from "./utils";

describe("truncate", () => {
  it("returns the string unchanged when shorter than limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string unchanged when exactly at limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and adds ellipsis when longer than limit", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("formatId", () => {
  it("returns the first 8 characters", () => {
    expect(formatId("abcdefghijklmnop")).toBe("abcdefgh");
  });

  it("returns the full string when shorter than 8 characters", () => {
    expect(formatId("abc")).toBe("abc");
  });
});

describe("slugify", () => {
  it("converts a simple phrase to snake_case", () => {
    expect(slugify("has unit tests")).toBe("has_unit_tests");
  });

  it("strips leading non-alpha characters", () => {
    expect(slugify("123 start")).toBe("start");
  });

  it("replaces special characters with underscores", () => {
    expect(slugify("uses Azure Bicep for IaC")).toBe("uses_azure_bicep_for_iac");
  });

  it("collapses multiple underscores", () => {
    expect(slugify("hello---world")).toBe("hello_world");
  });

  it("removes trailing underscores", () => {
    expect(slugify("trailing ")).toBe("trailing");
  });

  it("removes apostrophes", () => {
    expect(slugify("it's working")).toBe("its_working");
  });

  it("removes unicode apostrophes", () => {
    expect(slugify("it’s working")).toBe("its_working");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(50);
    expect(slugify(long)).toHaveLength(40);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });

  it("formats exact hours", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
  });
});
