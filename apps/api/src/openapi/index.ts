// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Import all route registrations (side effects)
import "./routes/requests.js";
// criteria: registered via apiRoute() in index.ts
import "./routes/prompt-features.js";
import "./routes/task-prompts.js";
import "./routes/reports.js";
import "./routes/report-templates.js";
import "./routes/insights.js";
import "./routes/agents.js";
// models: registered via apiRoute() in index.ts
// mcp-servers: registered via apiRoute() in index.ts
import "./routes/skills.js";
import "./routes/skill-revisions.js";
import "./routes/tokens.js";
import "./routes/accounts.js";
// feature-flags: registered via apiRoute() in index.ts

export { registry, generateOpenAPIDocument } from "./registry.js";
