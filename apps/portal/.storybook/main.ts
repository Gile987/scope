// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-vite",
  viteFinal: async (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": path.resolve(__dirname, "../src"),
    };
    config.define = {
      ...config.define,
      __GIT_COMMIT__: JSON.stringify("storybook"),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __GIT_BRANCH__: JSON.stringify("storybook"),
    };
    return config;
  },
};

export default config;
