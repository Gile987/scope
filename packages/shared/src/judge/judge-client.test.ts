// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { isRateLimitError, parseRateLimitBackoff } from "./judge-client.js";

describe("isRateLimitError", () => {
  it("detects 'rate limit' in error message", () => {
    expect(isRateLimitError(new Error("Sorry, you've hit a rate limit"))).toBe(true);
  });

  it("detects 'rate-limit' (hyphenated)", () => {
    expect(isRateLimitError(new Error("rate-limit exceeded"))).toBe(true);
  });

  it("detects 'Too Many Requests'", () => {
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  it("detects '429' with 'rate'", () => {
    expect(isRateLimitError(new Error("429 rate throttled"))).toBe(true);
  });

  it("does not match unrelated 429 errors without rate", () => {
    expect(isRateLimitError(new Error("HTTP 429 generic throttle"))).toBe(false);
  });

  it("does not match timeout errors", () => {
    expect(isRateLimitError(new Error("The operation was aborted"))).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("handles string errors", () => {
    expect(isRateLimitError("rate limit reached")).toBe(true);
  });
});

describe("parseRateLimitBackoff", () => {
  it("parses 'try again in 5 minutes'", () => {
    const err = new Error("Sorry, you've hit a rate limit. Please try again in 5 minutes.");
    expect(parseRateLimitBackoff(err)).toBe(5 * 60 * 1000);
  });

  it("parses 'try again in 5 hours' and caps at 30 minutes", () => {
    const err = new Error("Please try again in 5 hours.");
    expect(parseRateLimitBackoff(err)).toBe(30 * 60 * 1000); // Capped
  });

  it("parses 'try again in 30 seconds'", () => {
    const err = new Error("Please try again in 30 seconds.");
    expect(parseRateLimitBackoff(err)).toBe(30 * 1000);
  });

  it("returns default when no parseable duration", () => {
    const err = new Error("Rate limit hit, please wait");
    expect(parseRateLimitBackoff(err)).toBe(5 * 60 * 1000); // default
  });

  it("returns custom default when provided", () => {
    const err = new Error("Rate limit hit");
    expect(parseRateLimitBackoff(err, 60_000)).toBe(60_000);
  });

  it("handles null/undefined", () => {
    expect(parseRateLimitBackoff(null)).toBe(5 * 60 * 1000);
    expect(parseRateLimitBackoff(undefined)).toBe(5 * 60 * 1000);
  });
});
