// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vitest/config";

/**
 * Vitest config for **evals** — a distinct test category from unit and
 * integration tests.
 *
 * Evals call a real LLM and assert on the *majority* of N samples, so they are
 * non-deterministic, sample-based, and cost API quota. Keeping them out of the
 * unit suite (`vitest.config.ts` excludes `*.eval.test.ts`) and the integration
 * suite (they don't match `*.integration.test.ts`) gives a clean three-way split:
 * unit / integration / eval. Run with `pnpm test:eval` (all evals) or
 * `pnpm eval:criteria-prompts` (just the criteria-prompt orientation eval).
 */
export default defineConfig({
  // Resolve workspace packages (e.g. `llm-eval`, `shared`) from their TS
  // `source` export condition instead of built `dist/`. Eval CI does not build
  // every package (and `dist/` is gitignored), so without this vitest would try
  // `main: dist/index.js` and fail with "Failed to resolve entry for package".
  // Mirrors the root `vitest.config.ts`.
  ssr: {
    resolve: {
      conditions: ["source"],
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.eval.test.ts",
      "apps/*/src/**/*.eval.test.ts",
      "apps/workers/*/src/**/*.eval.test.ts",
      "apps/model-scanners/*/src/**/*.eval.test.ts",
    ],
    environment: "node",
    globals: false,
    testTimeout: 300_000, // 5 min — evals make many spaced real-LLM calls
    hookTimeout: 60_000,
    // Eval files share a single Models rate-limit budget, so run files serially;
    // in-file call spacing already paces individual requests.
    fileParallelism: false,
    // 429s are handled in-code via `withRetry`; a vitest-level retry of a whole
    // eval would re-run every sample and double LLM cost.
    retry: 0,
    reporters: [
      "github-actions",
      "default",
      [
        "@d2t/vitest-ctrf-json-reporter",
        {
          outputFile: "scope-mt-eval-ctrf-report.json",
          outputDir: "./ctrf",
        },
      ],
    ],
  },
});
