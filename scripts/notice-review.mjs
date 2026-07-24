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

const unknown = data["Unknown"] || [];
const rel = (p) => path.relative(repoRoot, p) || p;

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
      out.push("");
    }
  }
}

process.stdout.write(out.join("\n") + "\n");
