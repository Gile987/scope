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

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";

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
 * Resolve a zip entry's path inside `destDir`, guarding against Zip Slip.
 * Rejects absolute paths and any `..` traversal that would escape `destDir`.
 *
 * Exported for unit testing.
 */
export function resolveSafeEntryPath(destDir: string, entryName: string): string {
  // Normalize separators; zip entries use forward slashes by spec.
  const normalized = entryName.split("/").join(sep);
  const target = resolve(destDir, normalized);
  const root = resolve(destDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to extract zip entry outside target directory: '${entryName}'`);
  }
  return target;
}

/**
 * Safely extract a zip buffer into `destDir` using yauzl (no shell-out).
 * Every entry path is validated to stay within `destDir` before any write.
 */
async function extractZipBuffer(buffer: Buffer, destDir: string): Promise<void> {
  const yauzl = await import("yauzl");
  const { createWriteStream, mkdirSync } = await import("fs");

  await new Promise<void>((resolvePromise, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip archive"));
        return;
      }

      const fail = (e: unknown) => {
        zipfile.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      zipfile.on("error", fail);
      zipfile.on("end", () => resolvePromise());

      zipfile.on("entry", (entry) => {
        try {
          const target = resolveSafeEntryPath(destDir, entry.fileName);
          if (entry.fileName.endsWith("/")) {
            // Directory entry.
            mkdirSync(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          mkdirSync(dirname(target), { recursive: true });
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              fail(streamErr ?? new Error("Failed to read zip entry"));
              return;
            }
            const out = createWriteStream(target);
            readStream.on("error", fail);
            out.on("error", fail);
            out.on("close", () => zipfile.readEntry());
            readStream.pipe(out);
          });
        } catch (entryErr) {
          fail(entryErr);
        }
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Extract an archive buffer (tar.gz, tar, or zip) into `destDir`.
 * Detects the format from magic bytes.
 */
export async function extractArchiveBuffer(buffer: Buffer, destDir: string): Promise<void> {
  const format = detectFormat(buffer);
  if (format === "zip") {
    await extractZipBuffer(buffer, destDir);
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
