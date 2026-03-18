// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import {
  loadPinnedVersions,
  fetchNpmPackageVersion,
  fetchLatestVersions,
  fetchBundledSdkVersion,
  compareVersions,
} from "./check-versions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = resolve(__dirname, "..", ".tmp-test");

describe("check-versions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadPinnedVersions", () => {
    const versionsPath = resolve(TMP_DIR, "versions.env");

    beforeEach(() => {
      mkdirSync(TMP_DIR, { recursive: true });
    });

    afterAll(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it("parses CLAUDE_CODE_ACP_VERSION and CLAUDE_AGENT_SDK_VERSION from env file", () => {
      writeFileSync(
        versionsPath,
        "CLAUDE_CODE_ACP_VERSION=0.16.0\nCLAUDE_AGENT_SDK_VERSION=0.2.34\n"
      );

      const result = loadPinnedVersions(versionsPath);

      expect(result.claudeCodeAcpVersion).toBe("0.16.0");
      expect(result.claudeAgentSdkVersion).toBe("0.2.34");
    });

    it("ignores comments and blank lines", () => {
      writeFileSync(
        versionsPath,
        "# A comment\n\nCLAUDE_CODE_ACP_VERSION=0.15.0\n# Another\nCLAUDE_AGENT_SDK_VERSION=0.2.30\n"
      );

      const result = loadPinnedVersions(versionsPath);

      expect(result.claudeCodeAcpVersion).toBe("0.15.0");
      expect(result.claudeAgentSdkVersion).toBe("0.2.30");
    });

    it("throws when CLAUDE_CODE_ACP_VERSION is missing", () => {
      writeFileSync(versionsPath, "CLAUDE_AGENT_SDK_VERSION=0.2.34\n");

      expect(() => loadPinnedVersions(versionsPath)).toThrow(
        "Missing required versions"
      );
    });

    it("throws when CLAUDE_AGENT_SDK_VERSION is missing", () => {
      writeFileSync(versionsPath, "CLAUDE_CODE_ACP_VERSION=0.16.0\n");

      expect(() => loadPinnedVersions(versionsPath)).toThrow(
        "Missing required versions"
      );
    });

    it("throws when file does not exist", () => {
      expect(() => loadPinnedVersions("/nonexistent/path")).toThrow();
    });
  });

  describe("compareVersions", () => {
    it("returns no updates when versions match", () => {
      const result = compareVersions(
        { claudeCodeAcpVersion: "0.16.0", claudeAgentSdkVersion: "0.2.34" },
        { claudeCodeAcpVersion: "0.16.0", claudeAgentSdkVersion: "0.2.34" }
      );

      expect(result.hasUpdates).toBe(false);
      expect(result.claudeCodeAcp.current).toBe("0.16.0");
      expect(result.claudeCodeAcp.latest).toBe("0.16.0");
      expect(result.claudeAgentSdk.current).toBe("0.2.34");
      expect(result.claudeAgentSdk.latest).toBe("0.2.34");
    });

    it("detects claude-code-acp update", () => {
      const result = compareVersions(
        { claudeCodeAcpVersion: "0.16.0", claudeAgentSdkVersion: "0.2.34" },
        { claudeCodeAcpVersion: "0.16.2", claudeAgentSdkVersion: "0.2.34" }
      );

      expect(result.hasUpdates).toBe(true);
      expect(result.claudeCodeAcp.current).toBe("0.16.0");
      expect(result.claudeCodeAcp.latest).toBe("0.16.2");
    });

    it("detects claude-agent-sdk update", () => {
      const result = compareVersions(
        { claudeCodeAcpVersion: "0.16.0", claudeAgentSdkVersion: "0.2.34" },
        { claudeCodeAcpVersion: "0.16.0", claudeAgentSdkVersion: "0.2.44" }
      );

      expect(result.hasUpdates).toBe(true);
      expect(result.claudeAgentSdk.current).toBe("0.2.34");
      expect(result.claudeAgentSdk.latest).toBe("0.2.44");
    });

    it("detects both updates simultaneously", () => {
      const result = compareVersions(
        { claudeCodeAcpVersion: "0.16.0", claudeAgentSdkVersion: "0.2.34" },
        { claudeCodeAcpVersion: "0.16.2", claudeAgentSdkVersion: "0.2.44" }
      );

      expect(result.hasUpdates).toBe(true);
    });
  });

  describe("fetchNpmPackageVersion", () => {
    it("fetches package metadata from npm registry", async () => {
      const mockResponse = {
        version: "0.16.2",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "0.2.44",
        },
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await fetchNpmPackageVersion(
        "@zed-industries/claude-code-acp",
        "latest"
      );

      expect(result.version).toBe("0.16.2");
      expect(result.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toBe(
        "0.2.44"
      );
    });

    it("throws on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Not Found", { status: 404 })
      );

      await expect(
        fetchNpmPackageVersion("@zed-industries/claude-code-acp", "99.99.99")
      ).rejects.toThrow("npm registry returned 404");
    });
  });

  describe("fetchLatestVersions", () => {
    it("returns both latest versions from npm", async () => {
      const mockResponse = {
        version: "0.16.2",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "0.2.44",
          "@agentclientprotocol/sdk": "0.14.1",
        },
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await fetchLatestVersions();

      expect(result.claudeCodeAcpVersion).toBe("0.16.2");
      expect(result.claudeAgentSdkVersion).toBe("0.2.44");
    });

    it("throws when claude-agent-sdk is missing from dependencies", async () => {
      const mockResponse = {
        version: "0.16.2",
        dependencies: {},
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await expect(fetchLatestVersions()).rejects.toThrow(
        "@anthropic-ai/claude-agent-sdk not found"
      );
    });
  });

  describe("fetchBundledSdkVersion", () => {
    it("returns the SDK version bundled in a specific ACP version", async () => {
      const mockResponse = {
        version: "0.16.0",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "0.2.34",
        },
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await fetchBundledSdkVersion("0.16.0");

      expect(result).toBe("0.2.34");
    });

    it("throws when claude-agent-sdk is missing", async () => {
      const mockResponse = {
        version: "0.16.0",
        dependencies: {},
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await expect(fetchBundledSdkVersion("0.16.0")).rejects.toThrow(
        "@anthropic-ai/claude-agent-sdk not found"
      );
    });
  });
});
