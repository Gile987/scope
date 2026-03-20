// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the api module
vi.mock("@/lib/api", () => ({
  api: {
    getVersion: vi.fn(),
  },
}));

import { api } from "@/lib/api";

describe("useFavicon", () => {
  const mockLink = { href: "/favicon.svg" };

  beforeEach(() => {
    vi.stubGlobal("document", {
      querySelector: vi.fn().mockReturnValue(mockLink),
    });
    mockLink.href = "/favicon.svg";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sets white favicon for integration environment", async () => {
    vi.mocked(api.getVersion).mockResolvedValue({
      commit: "abc1234",
      buildTime: "2026-01-01T00:00:00Z",
      environment: "integration",
    });

    // Dynamically import to trigger the hook logic indirectly — we test the core logic
    const { setFaviconForEnvironment } = await import("./useFavicon.js");
    await setFaviconForEnvironment();

    expect(mockLink.href).toBe("/favicon-white.svg");
  });

  it("sets black favicon for production environment", async () => {
    vi.mocked(api.getVersion).mockResolvedValue({
      commit: "abc1234",
      buildTime: "2026-01-01T00:00:00Z",
      environment: "production",
    });

    const { setFaviconForEnvironment } = await import("./useFavicon.js");
    await setFaviconForEnvironment();

    expect(mockLink.href).toBe("/favicon-black.svg");
  });

  it("sets black favicon when environment is undefined", async () => {
    vi.mocked(api.getVersion).mockResolvedValue({
      commit: "abc1234",
      buildTime: "2026-01-01T00:00:00Z",
    });

    const { setFaviconForEnvironment } = await import("./useFavicon.js");
    await setFaviconForEnvironment();

    expect(mockLink.href).toBe("/favicon-black.svg");
  });

  it("does not throw when API call fails", async () => {
    vi.mocked(api.getVersion).mockRejectedValue(new Error("Network error"));

    const { setFaviconForEnvironment } = await import("./useFavicon.js");
    // Should not throw
    await setFaviconForEnvironment();

    // Favicon should remain unchanged
    expect(mockLink.href).toBe("/favicon.svg");
  });
});
