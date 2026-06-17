// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Runtime configuration for the portal.
//
// In production this file is regenerated at container start by
// docker-entrypoint.sh from the SCOPE_DOCS_BASE_URL environment variable, so
// the docs base URL can change per environment without rebuilding the image.
//
// In development (Vite) this static file is served as-is and provides the
// default values. Keep the shape in sync with the `Window.__SCOPE_CONFIG__`
// declaration in src/vite-env.d.ts.
window.__SCOPE_CONFIG__ = Object.assign(
  { docsBaseUrl: "https://urban-disco-1qzzq7z.pages.github.io" },
  window.__SCOPE_CONFIG__,
);
