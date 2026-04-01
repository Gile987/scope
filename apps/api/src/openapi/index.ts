// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Import all route registrations (side effects)
// requests: registered via apiRoute() in index.ts
// criteria: registered via apiRoute() in index.ts
// prompt-features: registered via apiRoute() in index.ts
// task-prompts: registered via apiRoute() in index.ts
// reports: registered via apiRoute() in index.ts
// report-templates: registered via apiRoute() in index.ts
// insights: registered via apiRoute() in index.ts
// agents: registered via apiRoute() in index.ts
// models: registered via apiRoute() in index.ts
// mcp-servers: registered via apiRoute() in index.ts
// skills: registered via apiRoute() in index.ts
// skill-revisions: registered via apiRoute() in index.ts
import "./routes/keys.js";
import "./routes/accounts.js";
// feature-flags: registered via apiRoute() in index.ts

export { registry, generateOpenAPIDocument } from "./registry.js";
