// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";
import type { CodebaseConfig } from "../types/codebase.js";
import type { CodebaseClient } from "./codebase-client.js";
import { seedCodebaseToWorkspace } from "./codebase-seeder.js";

function makeTestWorkspace(name: string): string {
  const baseDir = join(dirname(fileURLToPath(import.meta.url)), ".test-artifacts");
  mkdirSync(baseDir, { recursive: true });
  const dir = join(baseDir, `${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTestWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

async function makeTarGz(entries: Record<string, string>): Promise<Buffer> {
  const workspace = makeTestWorkspace("tar-input");
  try {
    for (const [relativePath, content] of Object.entries(entries)) {
      const fullPath = join(workspace, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
    const outPath = join(workspace, "archive.tar.gz");
    const tar = await import("tar");
    const topLevel = [...new Set(Object.keys(entries).map((path) => path.split("/")[0]))];
    await tar.create({ gzip: true, file: outPath, cwd: workspace }, topLevel);
    return readFileSync(outPath);
  } finally {
    cleanupTestWorkspace(workspace);
  }
}

function makeClient(archive: Buffer) {
  const config: CodebaseConfig = {
    ref: "pamelafox-site@r1",
    codebaseId: "codebase-1",
    revisionId: "revision-1",
    sourceType: "archive",
    archiveUrl: "https://blob.test/archive.tar.gz",
  };
  return {
    resolveCodebase: vi.fn(async () => config),
    downloadCodebaseArchive: vi.fn(async () => archive),
  };
}

describe("seedCodebaseToWorkspace", () => {
  it("downloads a normalized archive and extracts files at the workspace root", async () => {
    const archive = await makeTarGz({
      "package.json": "{\"name\":\"seeded\"}",
      "src/index.js": "console.log('seeded');",
    });
    const client = makeClient(archive);
    const workspace = makeTestWorkspace("seed-output");

    try {
      await expect(
        seedCodebaseToWorkspace({
          revisionId: "revision-1",
          codebaseClient: client as unknown as CodebaseClient,
          workspacePath: workspace,
        })
      ).resolves.toBe(true);

      expect(existsSync(join(workspace, "package.json"))).toBe(true);
      expect(existsSync(join(workspace, "src/index.js"))).toBe(true);
      expect(existsSync(join(workspace, "repo-main"))).toBe(false);
      expect(client.resolveCodebase).toHaveBeenCalledWith("revision-1");
      expect(client.downloadCodebaseArchive).toHaveBeenCalledWith("revision-1");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  it("returns false without extracting when revisionId is empty or undefined", async () => {
    const client = makeClient(Buffer.from("not used"));
    const workspace = makeTestWorkspace("seed-skipped");

    try {
      await expect(
        seedCodebaseToWorkspace({
          revisionId: "",
          codebaseClient: client as unknown as CodebaseClient,
          workspacePath: workspace,
        })
      ).resolves.toBe(false);
      await expect(
        seedCodebaseToWorkspace({
          revisionId: undefined as unknown as string,
          codebaseClient: client as unknown as CodebaseClient,
          workspacePath: workspace,
        })
      ).resolves.toBe(false);

      expect(client.resolveCodebase).not.toHaveBeenCalled();
      expect(client.downloadCodebaseArchive).not.toHaveBeenCalled();
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
