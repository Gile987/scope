#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// generate-notice.ts — Regenerate the root NOTICE (third-party OSS attributions)
// =============================================================================
// Produces a Microsoft-format NOTICE file attributing every third-party
// open-source component that this project *redistributes*.
//
// Scope (what is redistributed):
//   - Distributed artifacts are Docker images/services + the compiled `gateway`
//     Rust binary. Therefore only RUNTIME / PRODUCTION dependencies are attributed.
//   - JS/TS  : `pnpm licenses list --prod --json`  (devDependencies — build tooling
//              such as vite/vitest/eslint/tsx/storybook — are NOT shipped, excluded).
//   - Rust   : `cargo license --json --avoid-dev-deps` in apps/gateway (normal +
//              build deps linked into the release binary; dev/test-only crates excluded).
//
// First-party is excluded:
//   - pnpm workspace packages (already omitted by `pnpm licenses`).
//   - the `gateway` crate itself.
//
// Packages that are NOT open source, or whose license pnpm could not resolve
// ("Unknown"), are never emitted as OSS. They are collected, printed as a
// WARNING, and written to NOTICE-REVIEW.txt for manual / CELA review.
//
// Usage:
//   npx tsx scripts/generate-notice.ts            # regenerate NOTICE
//   npx tsx scripts/generate-notice.ts --check    # verify NOTICE is up to date (CI)
//   pnpm notice                                   # (npm script alias)
//
// Requirements: pnpm, and `cargo license` (install: `cargo install cargo-license`).
//   Set SKIP_CARGO=1 (or pass --no-cargo) to skip the Rust ecosystem.
// =============================================================================

import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const gatewayDir = join(repoRoot, "apps", "gateway");
const outFile = join(repoRoot, "NOTICE");
const reviewFile = join(repoRoot, "NOTICE-REVIEW.txt");

const args = new Set(process.argv.slice(2));
const CHECK_MODE = args.has("--check");
const SKIP_CARGO = args.has("--no-cargo") || process.env.SKIP_CARGO === "1";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
interface Component {
  ecosystem: "npm" | "cargo";
  name: string;
  versions: string[];
  license: string;
  publisher?: string;
  url?: string;
  licenseText: string;
  textSource: "file" | "synthesized" | "reference";
}

interface FlaggedComponent {
  ecosystem: "npm" | "cargo";
  name: string;
  versions: string[];
  reportedLicense: string;
  detectedLicense: string;
  reason: string;
  path?: string;
}

interface PnpmEntry {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  author?: string;
  homepage?: string;
}
type PnpmLicenses = Record<string, PnpmEntry[]>;

interface CargoEntry {
  name: string;
  version: string;
  authors?: string;
  repository?: string;
  license?: string;
  license_file?: string | null;
  description?: string;
}

// -----------------------------------------------------------------------------
// License file discovery / reading
// -----------------------------------------------------------------------------
function isLicenseFileName(name: string): boolean {
  const n = name.toUpperCase();
  return (
    n.startsWith("LICENSE") ||
    n.startsWith("LICENCE") ||
    n.startsWith("COPYING") ||
    n.startsWith("UNLICENSE") ||
    n === "NOTICE" ||
    n.startsWith("NOTICE.")
  );
}

function readLicenseTextFromDir(dir: string): string {
  if (!dir || !existsSync(dir)) return "";
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return "";
  }
  // LICENSE* sorts before NOTICE; keeps dual LICENSE-APACHE/LICENSE-MIT together.
  const files = entries.filter(isLicenseFileName).sort();
  const chunks: string[] = [];
  for (const f of files) {
    const p = join(dir, f);
    try {
      if (!statSync(p).isFile()) continue;
      const text = readFileSync(p, "utf-8").replace(/\r\n/g, "\n").trim();
      if (!text) continue;
      chunks.push(files.length > 1 ? `----- ${f} -----\n${text}` : text);
    } catch {
      /* ignore unreadable file */
    }
  }
  return chunks.join("\n\n");
}

// -----------------------------------------------------------------------------
// Synthesized standard license texts (only used when a package ships no text)
// -----------------------------------------------------------------------------
function synthMIT(holder: string): string {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

function synthISC(holder: string): string {
  return `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;
}

function synth0BSD(holder: string): string {
  return `BSD Zero Clause License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;
}

/** Best-effort text when a package ships no license file. */
function synthesizeLicense(
  spdx: string,
  holder: string,
  url?: string,
): { text: string; source: "synthesized" | "reference" } {
  const h = holder && holder.trim() ? holder.trim() : "the respective authors";
  switch (spdx) {
    case "MIT":
      return { text: synthMIT(h), source: "synthesized" };
    case "ISC":
      return { text: synthISC(h), source: "synthesized" };
    case "0BSD":
      return { text: synth0BSD(h), source: "synthesized" };
    default:
      return {
        text:
          `Copyright (c) ${h}\n\n` +
          `This component is distributed under the ${spdx} license. The package did ` +
          `not include a license text file; refer to the SPDX identifier above and ` +
          `the project home${url ? ` (${url})` : ""} for the authoritative terms.`,
        source: "reference",
      };
  }
}

// -----------------------------------------------------------------------------
// Proprietary / non-OSS detection
// -----------------------------------------------------------------------------
/** Try to recognise a non-OSS license from its text. */
function detectLicenseFromText(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("github copilot cli license")) {
    return "Proprietary — GitHub Copilot CLI License";
  }
  if (/\bmit license\b/.test(t)) return "MIT (per bundled text)";
  if (t.includes("apache license")) return "Apache-2.0 (per bundled text)";
  if (t.includes("proprietary") || t.includes("all rights reserved")) {
    return "Proprietary / all rights reserved";
  }
  return "Unrecognized";
}

const COPYLEFT_RE = /\b(GPL|LGPL|AGPL|MPL-|EUPL|CDDL|EPL-)/i;
/** A license expression is risky if it contains copyleft with no permissive OR-alternative. */
function isCopyleftWithoutPermissiveAlt(spdx: string): boolean {
  if (!COPYLEFT_RE.test(spdx)) return false;
  const alternatives = spdx.split(/\s+OR\s+/i).map((s) => s.trim());
  const permissive = /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|Unlicense|Zlib|BSL-1\.0|CC0-1\.0)/i;
  return !alternatives.some((a) => permissive.test(a.replace(/[()]/g, "")));
}

// -----------------------------------------------------------------------------
// Collectors
// -----------------------------------------------------------------------------
const components: Component[] = [];
const flagged: FlaggedComponent[] = [];
let missingTextCount = 0;

function collectNpm(): void {
  log("Enumerating npm production dependencies (pnpm licenses list --prod)…");
  const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const data = JSON.parse(raw) as PnpmLicenses;

  for (const [spdx, entries] of Object.entries(data)) {
    for (const entry of entries) {
      const dir = entry.paths[0] || "";

      // "Unknown" = pnpm could not resolve an SPDX id → never treat as OSS.
      if (spdx === "Unknown" || !spdx.trim()) {
        const text = readLicenseTextFromDir(dir);
        flagged.push({
          ecosystem: "npm",
          name: entry.name,
          versions: entry.versions,
          reportedLicense: spdx || "(empty)",
          detectedLicense: text ? detectLicenseFromText(text) : "No license text found",
          reason:
            "pnpm could not resolve an SPDX license id; requires manual / CELA review.",
          path: dir ? relative(repoRoot, dir) : undefined,
        });
        continue;
      }

      let licenseText = readLicenseTextFromDir(dir);
      let source: Component["textSource"] = "file";
      if (!licenseText) {
        const synth = synthesizeLicense(spdx, entry.author || "", entry.homepage);
        licenseText = synth.text;
        source = synth.source;
        missingTextCount++;
      }

      components.push({
        ecosystem: "npm",
        name: entry.name,
        versions: entry.versions.slice().sort(),
        license: spdx,
        publisher: entry.author,
        url: entry.homepage,
        licenseText,
        textSource: source,
      });

      if (isCopyleftWithoutPermissiveAlt(spdx)) {
        flagged.push({
          ecosystem: "npm",
          name: entry.name,
          versions: entry.versions,
          reportedLicense: spdx,
          detectedLicense: spdx,
          reason: "Copyleft license without a permissive OR-alternative — verify obligations.",
          path: dir ? relative(repoRoot, dir) : undefined,
        });
      }
    }
  }
}

function cargoSrcRoots(): string[] {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const base = join(cargoHome, "registry", "src");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .map((d) => join(base, d))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function findCrateDir(roots: string[], name: string, version: string): string {
  for (const root of roots) {
    const d = join(root, `${name}-${version}`);
    if (existsSync(d)) return d;
  }
  return "";
}

function collectCargo(): void {
  if (SKIP_CARGO) {
    log("Skipping Rust ecosystem (SKIP_CARGO / --no-cargo).");
    return;
  }
  log("Enumerating Rust gateway dependencies (cargo license --avoid-dev-deps)…");
  let raw: string;
  try {
    raw = execFileSync("cargo", ["license", "--json", "--avoid-dev-deps", "--current-dir", "."], {
      cwd: gatewayDir,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(
      "\nERROR: `cargo license` failed. Install it with `cargo install cargo-license`,\n" +
        "or pass --no-cargo / SKIP_CARGO=1 to generate an npm-only NOTICE.\n",
    );
    throw err;
  }
  const data = JSON.parse(raw) as CargoEntry[];
  const roots = cargoSrcRoots();

  // Group by crate name (a NOTICE attributes per component; list all versions).
  const byName = new Map<string, CargoEntry[]>();
  for (const c of data) {
    if (c.name === "gateway") continue; // first-party crate
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name)!.push(c);
  }

  for (const [name, entries] of byName) {
    const versions = [...new Set(entries.map((e) => e.version))].sort();
    const spdx = entries[0].license?.trim() || "";
    const authors = entries.find((e) => e.authors)?.authors;
    const repo = entries.find((e) => e.repository)?.repository;

    if (!spdx) {
      flagged.push({
        ecosystem: "cargo",
        name,
        versions,
        reportedLicense: "(none)",
        detectedLicense: "No SPDX license declared",
        reason: "Crate declares no license; requires manual / CELA review.",
      });
      continue;
    }

    // Read license text from the extracted crate source (highest version first).
    let licenseText = "";
    for (const v of versions.slice().reverse()) {
      const dir = findCrateDir(roots, name, v);
      if (dir) {
        licenseText = readLicenseTextFromDir(dir);
        if (licenseText) break;
      }
    }
    let source: Component["textSource"] = "file";
    if (!licenseText) {
      const synth = synthesizeLicense(spdx, authors || "", repo);
      licenseText = synth.text;
      source = synth.source;
      missingTextCount++;
    }

    components.push({
      ecosystem: "cargo",
      name,
      versions,
      license: spdx,
      publisher: authors,
      url: repo,
      licenseText,
      textSource: source,
    });

    if (isCopyleftWithoutPermissiveAlt(spdx)) {
      flagged.push({
        ecosystem: "cargo",
        name,
        versions,
        reportedLicense: spdx,
        detectedLicense: spdx,
        reason: "Copyleft license without a permissive OR-alternative — verify obligations.",
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------
const SEP = "=".repeat(80);
const SUB = "-".repeat(80);

function licenseBreakdown(list: Component[]): string {
  const counts = new Map<string, number>();
  for (const c of list) counts.set(c.license, (counts.get(c.license) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lic, n]) => `      ${String(n).padStart(4)}  ${lic}`)
    .join("\n");
}

function renderComponent(c: Component, index: number): string {
  const versions = c.versions.length ? ` ${c.versions.join(", ")}` : "";
  const lines = [
    SUB,
    `${index}. ${c.name}${versions}`,
    `    License: ${c.license}`,
  ];
  if (c.publisher) lines.push(`    Publisher: ${c.publisher}`);
  if (c.url) lines.push(`    Project: ${c.url}`);
  if (c.textSource === "synthesized") {
    lines.push(`    Note: package shipped no license file; standard ${c.license} text reproduced below.`);
  } else if (c.textSource === "reference") {
    lines.push(`    Note: package shipped no license file; see the SPDX id and project link above.`);
  }
  lines.push(SUB, "", c.licenseText, "");
  return lines.join("\n");
}

function renderSection(title: string, subtitle: string, list: Component[]): string {
  const sorted = list
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const out: string[] = [
    SEP,
    ` ${title}`,
    ` ${subtitle}`,
    ` ${sorted.length} components`,
    SEP,
    "",
    "License summary:",
    licenseBreakdown(sorted),
    "",
  ];
  sorted.forEach((c, i) => out.push(renderComponent(c, i + 1)));
  return out.join("\n");
}

function renderNotice(): string {
  const npm = components.filter((c) => c.ecosystem === "npm");
  const cargo = components.filter((c) => c.ecosystem === "cargo");

  const header = `NOTICES AND INFORMATION
Do Not Translate or Localize

This software incorporates material from third parties. Microsoft makes certain
open source code available at https://3rdpartysource.microsoft.com, or you may
send a check or money order for US $5.00, including the product name, the open
source component name, platform, and version number, to: Source Code Compliance
Team, Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, USA.
Notwithstanding any other terms, you may reverse engineer this software to the
extent required to debug changes to any libraries licensed under the GNU Lesser
General Public License.

This project incorporates components from the projects listed below. The original
copyright notices and the licenses under which Microsoft received such components
are set forth below. Microsoft reserves all rights not expressly granted herein,
whether by implication, estoppel or otherwise.

Only third-party components that this project redistributes at runtime are listed:
production npm dependencies (build/test-only devDependencies are excluded) and the
Rust crates linked into the gateway service binary (dev/test-only crates excluded).
First-party Microsoft/GitHub source in this repository is intentionally not listed.

This file is generated. Regenerate it with:  pnpm notice
`;

  const toc = `${SEP}
 Table of contents
${SEP}

  1. npm — production dependencies (${npm.length} components)
  2. cargo — apps/gateway runtime dependencies (${cargo.length} components)

  Total third-party OSS components attributed: ${components.length}
`;

  const parts = [
    header,
    toc,
    renderSection(
      "1. npm — production dependencies",
      "Node.js / TypeScript packages shipped in the service Docker images.",
      npm,
    ),
  ];
  if (cargo.length) {
    parts.push(
      renderSection(
        "2. cargo — apps/gateway runtime dependencies",
        "Rust crates linked into the gateway (AI proxy) release binary.",
        cargo,
      ),
    );
  }
  parts.push(`${SEP}\nEnd of NOTICES AND INFORMATION\n${SEP}`);
  return parts.join("\n") + "\n";
}

function renderReview(): string {
  const lines = [
    "NOTICE — MANUAL / CELA REVIEW REQUIRED",
    "",
    "The following redistributed components could NOT be attributed as standard",
    "open-source software and are intentionally excluded from the generated NOTICE.",
    "Each must be reviewed by CELA / OSPO before the OSS release.",
    "",
    "This file is generated by scripts/generate-notice.ts. Do not edit by hand.",
    "",
    SEP,
    "",
  ];
  if (!flagged.length) {
    lines.push("No components require manual review. ✔");
  } else {
    flagged.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.name} ${f.versions.join(", ")}  [${f.ecosystem}]`);
      lines.push(`   Reported license : ${f.reportedLicense}`);
      lines.push(`   Detected license : ${f.detectedLicense}`);
      lines.push(`   Reason           : ${f.reason}`);
      if (f.path) lines.push(`   Installed at     : ${f.path}`);
      lines.push("");
    });
  }
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
function log(msg: string): void {
  process.stderr.write(`[generate-notice] ${msg}\n`);
}

function main(): void {
  collectNpm();
  collectCargo();

  if (!components.length) {
    console.error("No components collected — aborting without writing NOTICE.");
    process.exit(1);
  }

  const notice = renderNotice();
  const review = renderReview();

  const npmCount = components.filter((c) => c.ecosystem === "npm").length;
  const cargoCount = components.filter((c) => c.ecosystem === "cargo").length;

  if (CHECK_MODE) {
    const current = existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
    if (current.trim() !== notice.trim()) {
      console.error(
        "NOTICE is out of date. Run `pnpm notice` and commit the result.",
      );
      process.exit(1);
    }
    log("NOTICE is up to date. ✔");
    return;
  }

  writeFileSync(outFile, notice, "utf-8");
  writeFileSync(reviewFile, review, "utf-8");

  log("");
  log(`Wrote ${outFile}`);
  log(`  npm production components   : ${npmCount}`);
  log(`  cargo runtime components    : ${cargoCount}`);
  log(`  total attributed            : ${components.length}`);
  log(`  synthesized/reference texts : ${missingTextCount} (package shipped no license file)`);
  log(`Wrote ${reviewFile}`);
  if (flagged.length) {
    log("");
    log(`⚠  ${flagged.length} component(s) need MANUAL / CELA review (excluded from NOTICE):`);
    for (const f of flagged) {
      log(`     - ${f.name} ${f.versions.join(", ")} [${f.ecosystem}] → ${f.detectedLicense}`);
    }
  } else {
    log("No components require manual review.");
  }
}

main();
