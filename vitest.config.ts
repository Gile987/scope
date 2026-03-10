// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/workers/*/src/**/*.test.ts", "apps/workers/*/scripts/**/*.test.ts", "apps/model-scanners/*/src/**/*.test.ts", "apps/version-checkers/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/*.integration.test.ts"],
    environment: "node",
    globals: false,
    reporters: [
      "github-actions",
      "default",
      [
        "@d2t/vitest-ctrf-json-reporter",
        {
          outputFile: "scope-mt-ctrf-report.json",
          outputDir: "./ctrf",
        },
      ],
    ],
    coverage: {
      reporter: ["text", "json", "json-summary", "html"],
      provider: "v8",
      exclude: [
        "node_modules/",
        "dist/",
        "coverage/",
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.spec.ts",
      ],
    },
  },
});
