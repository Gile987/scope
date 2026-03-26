// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Import all route registrations (side effects)
import "./routes/health.js";
import "./routes/requests.js";
import "./routes/criteria.js";
import "./routes/prompt-features.js";
import "./routes/task-prompts.js";
import "./routes/reports.js";
import "./routes/report-templates.js";
import "./routes/insights.js";
import "./routes/agents.js";
// models: migrated to src/routes/models.ts (uses apiRoute())
// mcp-servers: migrated to src/routes/mcp-servers.ts (uses apiRoute())
import "./routes/skills.js";
import "./routes/skill-revisions.js";
import "./routes/tokens.js";
import "./routes/accounts.js";
// feature-flags: migrated to src/routes/feature-flags.ts (uses apiRoute())

export { registry, generateOpenAPIDocument } from "./registry.js";
