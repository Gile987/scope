// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import yazl from "yazl";
import { extractArchiveBuffer, resolveSafeEntryPath, assertTarEntrySafe } from "./codebase-archive.js";

/** Build an in-memory zip from a map of entry name -> contents. */
async function makeZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(content), name);
  }
  zip.end();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/**
 * yazl refuses to write malicious entry names, so build a benign zip whose
 * entry name has the same byte length, then patch the filename bytes (which
 * appear in the local + central headers) to the malicious value. Equal length
 * keeps every zip offset/length field valid.
 */
async function makeMaliciousZip(maliciousName: string, content: string): Promise<Buffer> {
  const placeholder = "p".repeat(maliciousName.length);
  const buffer = await makeZip({ [placeholder]: content });
  const malicious = Buffer.from(maliciousName, "utf8");
  const safe = Buffer.from(placeholder, "utf8");
  let idx = buffer.indexOf(safe);
  while (idx !== -1) {
    malicious.copy(buffer, idx);
    idx = buffer.indexOf(safe, idx + safe.length);
  }
  return buffer;
}

describe("resolveSafeEntryPath", () => {
  const dest = "/tmp/codebase-dest";

  it("resolves a normal nested path inside destDir", () => {
    expect(resolveSafeEntryPath(dest, "src/index.ts")).toBe(join(dest, "src", "index.ts"));
  });

  it("rejects a '../' traversal escaping destDir", () => {
    expect(() => resolveSafeEntryPath(dest, "../evil.txt")).toThrow(/outside target directory/);
  });

  it("rejects a deep '../../' traversal", () => {
    expect(() => resolveSafeEntryPath(dest, "a/../../evil.txt")).toThrow(/outside target directory/);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveSafeEntryPath(dest, "/etc/passwd")).toThrow(/outside target directory/);
  });
});

describe("extractArchiveBuffer (zip)", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const d = mkdtempSync(join(tmpdir(), "codebase-archive-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("extracts a well-formed zip into the destination", async () => {
    const buffer = await makeZip({
      "README.md": "hello",
      "src/index.ts": "export const x = 1;",
    });
    const dest = newDir();
    await extractArchiveBuffer(buffer, dest);

    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("creates nested directories from entries", async () => {
    const buffer = await makeZip({ "a/b/c.txt": "deep" });
    const dest = newDir();
    await extractArchiveBuffer(buffer, dest);

    expect(readdirSync(join(dest, "a", "b"))).toContain("c.txt");
    expect(readFileSync(join(dest, "a", "b", "c.txt"), "utf8")).toBe("deep");
  });

  it("rejects a zip whose entry escapes the destination via '../' (Zip Slip)", async () => {
    const buffer = await makeMaliciousZip("../evil.txt", "pwned");
    const dest = newDir();

    await expect(extractArchiveBuffer(buffer, dest)).rejects.toThrow(
      /outside target directory|invalid relative path/
    );
    expect(existsSync(join(dest, "..", "evil.txt"))).toBe(false);
  });
});

describe("assertTarEntrySafe", () => {
  const dest = "/tmp/codebase-dest";

  it("accepts a normal nested path", () => {
    expect(assertTarEntrySafe(dest, "src/index.ts")).toBe(true);
  });

  it("rejects a '../' traversal escaping destDir", () => {
    expect(() => assertTarEntrySafe(dest, "../evil.txt")).toThrow(/outside target directory/);
  });

  it("rejects an absolute entry path", () => {
    expect(() => assertTarEntrySafe(dest, "/etc/passwd")).toThrow(/outside target directory/);
  });

  it("accepts a symlink whose target stays inside destDir", () => {
    expect(assertTarEntrySafe(dest, "link", "real.txt")).toBe(true);
  });

  it("rejects a symlink whose target escapes destDir", () => {
    expect(() => assertTarEntrySafe(dest, "link", "../../etc/passwd")).toThrow(
      /link escaping target directory/
    );
  });
});

describe("extractArchiveBuffer (tar.gz)", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const d = mkdtempSync(join(tmpdir(), "codebase-archive-tar-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("extracts a well-formed tar.gz into the destination", async () => {
    const tar = await import("tar");
    const src = newDir();
    writeFileSync(join(src, "README.md"), "hello tar");
    mkdirSync(join(src, "src"));
    writeFileSync(join(src, "src", "index.ts"), "export const y = 2;");

    const tgz = newDir();
    const tgzPath = join(tgz, "out.tar.gz");
    await tar.create({ gzip: true, file: tgzPath, cwd: src }, ["README.md", "src"]);
    const buffer = readFileSync(tgzPath);

    const dest = newDir();
    await extractArchiveBuffer(buffer, dest);

    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("hello tar");
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const y = 2;");
  });
});
