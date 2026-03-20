// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import path from "path";

function getGitBranch(): string {
  if (process.env.GIT_BRANCH) return process.env.GIT_BRANCH;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __GIT_COMMIT__: JSON.stringify(process.env.GIT_COMMIT || "development"),
    __BUILD_TIME__: JSON.stringify(process.env.BUILD_TIME || new Date().toISOString()),
    __GIT_BRANCH__: JSON.stringify(getGitBranch()),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5100,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
    },
  },
});
