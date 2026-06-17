// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DOCS_BASE, docsUrl, getDocsBase } from "./docs.js";

afterEach(() => {
  delete window.__SCOPE_CONFIG__;
});

describe("getDocsBase", () => {
  it("falls back to the default base when no runtime config is present", () => {
    expect(getDocsBase()).toBe(DEFAULT_DOCS_BASE);
  });

  it("uses the runtime-configured docs base", () => {
    window.__SCOPE_CONFIG__ = { docsBaseUrl: "https://docs.example.com" };
    expect(getDocsBase()).toBe("https://docs.example.com");
  });

  it("strips a trailing slash from the configured base", () => {
    window.__SCOPE_CONFIG__ = { docsBaseUrl: "https://docs.example.com/" };
    expect(getDocsBase()).toBe("https://docs.example.com");
  });

  it("ignores a whitespace-only base and uses the default", () => {
    window.__SCOPE_CONFIG__ = { docsBaseUrl: "   " };
    expect(getDocsBase()).toBe(DEFAULT_DOCS_BASE);
  });
});

describe("docsUrl", () => {
  it("appends the page slug to the default base", () => {
    expect(docsUrl("criteria")).toBe(`${DEFAULT_DOCS_BASE}/guides/defining-criteria/`);
  });

  it("uses the runtime base without producing a double slash", () => {
    window.__SCOPE_CONFIG__ = { docsBaseUrl: "https://docs.example.com/" };
    expect(docsUrl("glossary")).toBe("https://docs.example.com/resources/glossary/");
  });
});
