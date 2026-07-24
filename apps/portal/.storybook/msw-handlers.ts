// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { http, HttpResponse } from "msw";

export const mswHandlers = [
  // Feature flags — return empty array (all features enabled by default)
  http.get("/api/v1/feature-flags", () => HttpResponse.json([])),
  // Projects — a single demo project so the ProjectSwitcher and project-scoped
  // nav have something to resolve against in stories.
  http.get("/api/v1/projects", () =>
    HttpResponse.json([
      { _id: "demo-project", id: "demo-project", name: "Demo Project" },
    ]),
  ),
];
