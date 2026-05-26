// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { http, HttpResponse } from "msw";

export const mswHandlers = [
  // Feature flags — return empty array (all features enabled by default)
  http.get("/api/v1/feature-flags", () => HttpResponse.json([])),
];
