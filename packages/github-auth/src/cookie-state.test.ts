// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { isCookieStateExpired } from "./cookie-state.js";

function makeStorageState(cookies: Array<{ name: string; domain: string; expires: number }>) {
  return JSON.stringify({ cookies });
}

describe("isCookieStateExpired", () => {
  const NOW = 1700000000; // Arbitrary fixed epoch seconds

  it("returns true for unparseable JSON", () => {
    expect(isCookieStateExpired("not json", NOW)).toBe(true);
  });

  it("returns true when cookies array is missing", () => {
    expect(isCookieStateExpired("{}", NOW)).toBe(true);
  });

  it("returns true when cookies is not an array", () => {
    expect(isCookieStateExpired('{"cookies": "nope"}', NOW)).toBe(true);
  });

  it("returns true when no user_session cookie exists", () => {
    const state = makeStorageState([
      { name: "other_cookie", domain: "github.com", expires: NOW + 3600 },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(true);
  });

  it("returns true when user_session is on wrong domain", () => {
    const state = makeStorageState([
      { name: "user_session", domain: "example.com", expires: NOW + 3600 },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(true);
  });

  it("returns true when user_session has expired", () => {
    const state = makeStorageState([
      { name: "user_session", domain: "github.com", expires: NOW - 1 },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(true);
  });

  it("returns true when user_session expires exactly now", () => {
    const state = makeStorageState([
      { name: "user_session", domain: "github.com", expires: NOW },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(true);
  });

  it("returns false when user_session is valid (future expiry)", () => {
    const state = makeStorageState([
      { name: "user_session", domain: "github.com", expires: NOW + 3600 },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(false);
  });

  it("returns false for session cookie (expires = -1)", () => {
    const state = makeStorageState([
      { name: "user_session", domain: "github.com", expires: -1 },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(false);
  });

  it("ignores non-github.com user_session cookies", () => {
    const state = makeStorageState([
      { name: "user_session", domain: "evil.com", expires: NOW + 3600 },
      { name: "logged_in", domain: "github.com", expires: NOW + 3600 },
    ]);
    expect(isCookieStateExpired(state, NOW)).toBe(true);
  });
});
