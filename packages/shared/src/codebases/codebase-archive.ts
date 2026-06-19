// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Codebase archive helpers.
 *
 * Both source types (git tarball download, user upload) are normalized to a
 * single canonical form: a gzipped tar whose entries live at the archive root
 * (no wrapper directory). This lets the worker seeder extract every codebase
 * revision the same way — straight into the workspace root, with no
 * `--strip-components` guesswork.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Result of normalizing an archive to a root-level tar.gz. */
export interface NormalizedArchive {
  /** The normalized tar.gz bytes (entries at root). */
  data: Buffer;
  /** Number of files (not directories) in the snapshot. */
  fileCount: number;
  /** Size of the normalized archive in bytes. */
  sizeBytes: number;
}

function detectFormat(buffer: Buffer): "gzip" | "zip" | "tar" | "unknown" {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "gzip";
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
  // tar "ustar" magic lives at offset 257
  if (buffer.length >= 262 && buffer.toString("ascii", 257, 262) === "ustar") return "tar";
  return "unknown";
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(full);
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Extract an archive buffer (tar.gz, tar, or zip) into `destDir`.
 * Detects the format from magic bytes.
 */
export async function extractArchiveBuffer(buffer: Buffer, destDir: string): Promise<void> {
  const format = detectFormat(buffer);
  if (format === "zip") {
    const tmp = mkdtempSync(join(tmpdir(), "codebase-zip-"));
    const zipPath = join(tmp, "archive.zip");
    const { writeFileSync } = await import("fs");
    writeFileSync(zipPath, buffer);
    try {
      execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: "pipe" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  // tar.gz / tar — the `tar` lib auto-detects gzip.
  const tar = await import("tar");
  const { writeFileSync } = await import("fs");
  const tmp = mkdtempSync(join(tmpdir(), "codebase-tar-"));
  const tarPath = join(tmp, "archive.tar");
  writeFileSync(tarPath, buffer);
  try {
    await tar.extract({ file: tarPath, cwd: destDir });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Normalize an arbitrary archive buffer to a root-level tar.gz.
 *
 * Extracts the input, unwraps a single top-level directory if present
 * (e.g. GitHub tarballs are wrapped in `{owner}-{repo}-{sha}/`), then re-archives
 * the contents at the root.
 */
export async function normalizeToRootTarGz(buffer: Buffer): Promise<NormalizedArchive> {
  const tar = await import("tar");
  const workDir = mkdtempSync(join(tmpdir(), "codebase-normalize-"));
  const extractDir = join(workDir, "extracted");
  const { mkdirSync } = await import("fs");
  mkdirSync(extractDir, { recursive: true });

  try {
    await extractArchiveBuffer(buffer, extractDir);

    // Unwrap a single top-level directory.
    const entries = readdirSync(extractDir, { withFileTypes: true }).filter(
      (e) => e.name !== "." && e.name !== ".."
    );
    let rootDir = extractDir;
    if (entries.length === 1 && entries[0].isDirectory()) {
      rootDir = join(extractDir, entries[0].name);
    }

    const fileCount = countFiles(rootDir);
    const topLevel = readdirSync(rootDir).filter((n) => n !== "." && n !== "..");

    const outPath = join(workDir, "normalized.tar.gz");
    await tar.create({ gzip: true, file: outPath, cwd: rootDir }, topLevel);

    const data = readFileSync(outPath);
    return { data, fileCount, sizeBytes: statSync(outPath).size };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
