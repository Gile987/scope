// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import {
  loadPinnedVersions,
  fetchLatestCopilotCliVersion,
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

    it("parses COPILOT_CLI_VERSION from env file", () => {
      writeFileSync(versionsPath, "COPILOT_CLI_VERSION=0.0.415\n");

      const result = loadPinnedVersions(versionsPath);

      expect(result.copilotCliVersion).toBe("0.0.415");
    });

    it("ignores comments and blank lines", () => {
      writeFileSync(
        versionsPath,
        "# A comment\n\nCOPILOT_CLI_VERSION=0.0.400\n# Another\n"
      );

      const result = loadPinnedVersions(versionsPath);

      expect(result.copilotCliVersion).toBe("0.0.400");
    });

    it("throws when COPILOT_CLI_VERSION is missing", () => {
      writeFileSync(versionsPath, "SOME_OTHER_VAR=1.0.0\n");

      expect(() => loadPinnedVersions(versionsPath)).toThrow(
        "Missing required version"
      );
    });

    it("throws when file does not exist", () => {
      expect(() => loadPinnedVersions("/nonexistent/path")).toThrow();
    });
  });

  describe("compareVersions", () => {
    it("returns no updates when versions match", () => {
      const result = compareVersions(
        { copilotCliVersion: "0.0.415" },
        { copilotCliVersion: "0.0.415" }
      );

      expect(result.hasUpdates).toBe(false);
      expect(result.copilotCli.current).toBe("0.0.415");
      expect(result.copilotCli.latest).toBe("0.0.415");
    });

    it("detects Copilot CLI update", () => {
      const result = compareVersions(
        { copilotCliVersion: "0.0.415" },
        { copilotCliVersion: "0.0.420" }
      );

      expect(result.hasUpdates).toBe(true);
      expect(result.copilotCli.current).toBe("0.0.415");
      expect(result.copilotCli.latest).toBe("0.0.420");
    });
  });

  describe("fetchLatestCopilotCliVersion", () => {
    it("returns the latest version from npm registry", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          "dist-tags": { latest: "0.0.420" },
        })
      );
      vi.spyOn(global, "fetch").mockResolvedValue(mockResponse);

      const version = await fetchLatestCopilotCliVersion();

      expect(version).toBe("0.0.420");
      expect(fetch).toHaveBeenCalledWith(
        "https://registry.npmjs.org/@github/copilot"
      );
    });

    it("throws on non-200 response", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("error", { status: 500 })
      );

      await expect(fetchLatestCopilotCliVersion()).rejects.toThrow(
        "returned 500"
      );
    });

    it("throws when dist-tags.latest is missing", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ "dist-tags": {} }))
      );

      await expect(fetchLatestCopilotCliVersion()).rejects.toThrow(
        "missing dist-tags.latest"
      );
    });

    it("throws when dist-tags is missing entirely", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({}))
      );

      await expect(fetchLatestCopilotCliVersion()).rejects.toThrow(
        "missing dist-tags.latest"
      );
    });
  });
});
