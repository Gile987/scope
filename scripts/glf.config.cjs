// Configuration for `generate-license-file`, consumed by scripts/generate-notice.sh.
//
// This file only ORCHESTRATES the tool (which packages to scan, which to skip,
// and — for packages that ship more than one license file — which of the
// package's OWN files to quote). It never contains or authors any license text:
// every attribution in NOTICE is extracted verbatim by the tool from each
// dependency's own LICENSE file under node_modules.
//
// See: https://generate-license-file.js.org/docs/cli/config-file

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

// generate-license-file resolves pnpm workspaces by delegating to
// `pnpm licenses list --prod`, which is WORKSPACE-WIDE: pointing it at the root
// package.json enumerates the production dependencies of every workspace member
// in one pass. (Passing each member package.json individually is redundant and
// would also drag in non-workspace projects such as `website/`, the standalone
// Astro docs site, which is not a pnpm workspace member and is not installed
// here — it is out of scope for this NOTICE and, if ever published, needs its
// own.)
const inputs = [path.join(repoRoot, "package.json")];

// Packages deliberately kept OUT of the auto-generated OSS NOTICE body.
//
// @github/copilot and its per-platform binaries (@github/copilot-<os>-<arch>,
// e.g. -darwin-arm64, -linux-x64) are the GitHub Copilot CLI, which is
// PROPRIETARY (the "GitHub Copilot CLI License", not an OSS license). They are
// enumerated separately in NOTICE-REVIEW.txt for manual/CELA determination.
//
// NOTE: @github/copilot-sdk is a genuine MIT package and is intentionally NOT
// matched by this pattern, so it stays in the OSS NOTICE.
const exclude = ["/^@github\\/copilot(-(darwin|linux|win32)-(arm64|x64))?(@.*)?$/"];

// Disambiguate packages that ship MORE THAN ONE license file. generate-license-file
// refuses to guess (and, under --ci, fails) so it does not silently pick the wrong
// text. We resolve each case by pointing the tool at ONE of the package's OWN real
// license files — never at hand-written text.
//
// Currently the only such package is `qr`, published under "(MIT OR Apache-2.0)",
// which ships both LICENSE (Apache-2.0) and LICENSE-MIT. We elect the MIT arm by
// quoting the package's own LICENSE-MIT verbatim.
//
// If a future dependency introduces another multi-license package, the tool will
// fail loudly under --ci; add a corresponding entry here pointing at that
// package's own license file.
const replace = {};

/**
 * Locate an unscoped package's install directory in the pnpm store and return
 * its version plus the absolute path to a given license filename, if present.
 */
function resolvePnpmLicense(pkgName, licenseFileName) {
  const store = path.join(repoRoot, "node_modules", ".pnpm");
  if (!fs.existsSync(store)) return null;
  const prefix = `${pkgName}@`;
  for (const entry of fs.readdirSync(store)) {
    // Match "<name>@<version>" exactly (avoid e.g. "qrcode@..." for "qr").
    if (!entry.startsWith(prefix) || !/^[^@]+@\d/.test(entry)) continue;
    const pkgDir = path.join(store, entry, "node_modules", pkgName);
    const licensePath = path.join(pkgDir, licenseFileName);
    if (fs.existsSync(licensePath)) {
      // Version is the store-entry segment after "<name>@", minus any pnpm
      // peer-dependency suffix in parentheses.
      const version = entry.slice(prefix.length).replace(/\(.*$/, "");
      return { version, licensePath };
    }
  }
  return null;
}

const qr = resolvePnpmLicense("qr", "LICENSE-MIT");
if (qr) replace[`qr@${qr.version}`] = qr.licensePath;

module.exports = {
  inputs,
  exclude,
  replace,
  omitVersions: false,
};
