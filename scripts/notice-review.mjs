#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Emits NOTICE-REVIEW.txt: the production packages that pnpm cannot classify as
// a known OSS license (its "Unknown" bucket). These are excluded from the OSS
// NOTICE and require manual / legal (CELA) determination before the OSS release.
//
// This script authors NO license text. It reads the machine output of
//   pnpm licenses list --prod --json
// on stdin and prints only mechanically-extracted metadata plus pointers to the
// license file each package bundles, so a reviewer can read the real terms.
//
// Usage: pnpm licenses list --prod --json | node scripts/notice-review.mjs [repoRoot]

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] || process.cwd());
const raw = fs.readFileSync(0, "utf8");

let data = {};
try {
  data = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`notice-review: could not parse pnpm JSON: ${err.message}\n`);
  process.exit(1);
}

const rel = (p) => path.relative(repoRoot, p) || p;

// pnpm reports whichever per-platform native binary is installed on THIS machine
// (e.g. @github/copilot-darwin-arm64 on macOS, @github/copilot-linux-x64 on the
// Linux CI runner, @github/copilot-linuxmusl-x64 in the Alpine images). Listing
// that machine-specific package here would make this file differ per platform and
// break `pnpm notice:check`. We therefore drop the per-platform binaries from the
// listing and instead enumerate them from their parent package's
// `optionalDependencies`, which is identical on every platform.
const PLATFORM_BINARY = /-(linux|linuxmusl|darwin|win32)-(x64|arm64)$/;
const unknown = (data["Unknown"] || []).filter((p) => !PLATFORM_BINARY.test(p.name));

function licenseFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE|PATENTS)/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

// Enumerate a package's own per-platform binary optionalDependencies (name@range),
// read verbatim from its package.json — reproducible regardless of host platform.
function platformBinaries(dir) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const od = pj.optionalDependencies || {};
    return Object.keys(od)
      .filter((n) => PLATFORM_BINARY.test(n))
      .sort()
      .map((n) => `${n}@${od[n]}`);
  } catch {
    return [];
  }
}

const out = [];
out.push("Scope - PACKAGES REQUIRING MANUAL / LEGAL (CELA) REVIEW");
out.push("");
out.push(
  "The production packages listed below could not be matched to a known open",
);
out.push(
  "source license by `pnpm licenses list --prod --json` (they fall in its",
);
out.push(
  '"Unknown" bucket). They are deliberately EXCLUDED from the attributions in',
);
out.push(
  "NOTICE and must be reviewed manually before the open source release. Read the",
);
out.push(
  "bundled license file referenced for each package to determine the real terms;",
);
out.push("this file intentionally does not reproduce or summarize those terms.");
out.push("");
out.push(
  "Each package's per-platform native binaries are listed from its own",
);
out.push(
  "optionalDependencies (identical on every OS/arch) instead of by whichever",
);
out.push(
  "binary is installed on this machine, so this listing is reproducible in CI.",
);
out.push("");
out.push("=".repeat(79));
out.push("");

if (unknown.length === 0) {
  out.push("No production packages currently require manual review.");
} else {
  for (const pkg of unknown.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    for (const version of pkg.versions) {
      out.push(`- ${pkg.name}@${version}`);
      if (pkg.author) out.push(`    Publisher:   ${pkg.author}`);
      if (pkg.homepage) out.push(`    Homepage:    ${pkg.homepage}`);
      if (pkg.description) out.push(`    Description: ${pkg.description}`);
      out.push(`    Declared "license" (package.json): ${pkg.license}`);
      for (const p of pkg.paths || []) {
        out.push(`    Install path:             ${rel(p)}`);
        const files = licenseFiles(p);
        if (files.length) {
          out.push(`    Bundled license file(s):  ${files.join(", ")}`);
        } else {
          out.push("    Bundled license file(s):  (none found)");
        }
      }
      const bins = (pkg.paths || []).flatMap(platformBinaries);
      if (bins.length) {
        out.push(
          "    Per-platform native binaries (optionalDependencies; each ships",
        );
        out.push(
          "    the same proprietary license — review it too):",
        );
        for (const b of [...new Set(bins)].sort()) out.push(`      - ${b}`);
      }
      out.push("");
    }
  }
}

process.stdout.write(out.join("\n") + "\n");
