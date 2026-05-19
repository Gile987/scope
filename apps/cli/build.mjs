// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// ESM banner: shebang + createRequire polyfill for CJS deps (e.g. dotenv uses require("fs"))
const banner = `#!/usr/bin/env node
import { createRequire as __createRequire } from "module";
import { fileURLToPath as __fileURLToPath } from "url";
import { dirname as __dirname_ } from "path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
`;

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/scope.mjs",
  minify: true,
  treeShaking: true,
  banner: { js: banner },
  define: {
    "process.env.SCOPE_CLI_VERSION": JSON.stringify(pkg.version),
    "process.env.SCOPE_DEFAULT_API_URL": JSON.stringify(
      process.env.SCOPE_DEFAULT_API_URL || "http://scope.eastus2.cloudapp.azure.com"
    ),
  },
  external: [],
  logLevel: "warning",
  plugins: [{
    name: "strip-shebang",
    setup(build) {
      build.onLoad({ filter: /index\.ts$/ }, async (args) => {
        let contents = readFileSync(args.path, "utf-8");
        if (contents.startsWith("#!")) {
          contents = contents.replace(/^#![^\n]*\n/, "");
        }
        return { contents, loader: "ts" };
      });
    },
  }, {
    name: "shim-react-devtools",
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: "react-devtools-core",
        namespace: "shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        contents: "export default undefined;",
        loader: "js",
      }));
    },
  }],
});

console.log(`✓ Built dist/scope.mjs (v${pkg.version})`);
