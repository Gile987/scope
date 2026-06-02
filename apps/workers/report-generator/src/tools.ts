// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool } from "@github/copilot-sdk";

/**
 * Options for creating report tools.
 */
export interface CreateReportToolsOptions {
  /** Base URL of the scope-mt API (for insight CRUD only) */
  apiBaseUrl: string;
  /** Report ID for linking insights */
  reportId: string;
}

/**
 * Create insight tools for the report agent.
 *
 * All run data is pre-extracted to disk before the Copilot SDK session starts.
 * The SDK's built-in tools (view, grep, glob, bash) handle file access via
 * the `workingDirectory` session config option. These custom tools handle
 * only insight CRUD operations against the API.
 */
export function createReportTools(options: CreateReportToolsOptions) {
  const { apiBaseUrl, reportId } = options;

  const searchInsights = defineTool("search_insights", {
    description:
      "Search existing insights by keyword query. Use this to check if a similar insight already exists before creating a new one. Returns matching insights sorted by reference count.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword search query to find similar insights.",
        },
      },
      required: ["query"],
    },
    handler: async (args: { query: string }) => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/v1/insights/search?q=${encodeURIComponent(args.query)}&blocked=false`
        );
        if (!response.ok) {
          return { error: `Failed to search insights: ${response.status} ${response.statusText}` };
        }
        const insights = await response.json();
        return {
          insights: insights.map((i: any) => ({
            id: i._id,
            title: i.title,
            description: i.description,
            category: i.category,
            referenceCount: i.referenceCount,
          })),
          total: insights.length,
        };
      } catch (err) {
        return { error: `Failed to search insights: ${err}` };
      }
    },
  });

  const createInsight = defineTool("create_insight", {
    description:
      "Create a brand-new insight. Only use this when search_insights confirms no similar insight exists. The description should be markdown-formatted.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short summary of the insight (one line).",
        },
        description: {
          type: "string",
          description: "Detailed markdown-formatted observation explaining the insight.",
        },
        category: {
          type: "string",
          description: "Category tag (e.g. 'agent-behavior', 'criteria-handling', 'tool-usage', 'scenario-design').",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags for discoverability.",
        },
      },
      required: ["title", "description"],
    },
    handler: async (args: { title: string; description: string; category?: string; tags?: string[] }) => {
      try {
        const createResponse = await fetch(`${apiBaseUrl}/api/v1/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: args.title,
            description: args.description,
            category: args.category,
            tags: args.tags,
            createdBy: "agent",
            sourceReportId: reportId,
          }),
        });
        if (!createResponse.ok) {
          return { error: `Failed to create insight: ${createResponse.status} ${createResponse.statusText}` };
        }
        const insight = await createResponse.json();

        const refResponse = await fetch(`${apiBaseUrl}/api/v1/reports/${reportId}/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ insightId: insight._id, isNew: true }),
        });
        if (!refResponse.ok) {
          return { id: insight._id, title: insight.title, warning: "Created but failed to link to report" };
        }

        return { id: insight._id, title: insight.title, created: true, linkedToReport: true };
      } catch (err) {
        return { error: `Failed to create insight: ${err}` };
      }
    },
  });

  const referenceInsight = defineTool("reference_insight", {
    description:
      "Reference an existing insight from this report. Use this when search_insights found a matching insight.",
    parameters: {
      type: "object",
      properties: {
        insightId: {
          type: "string",
          description: "The ID of the existing insight to reference.",
        },
      },
      required: ["insightId"],
    },
    handler: async (args: { insightId: string }) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/reports/${reportId}/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ insightId: args.insightId, isNew: false }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          return { error: err.error || `Failed to reference insight: ${response.status}` };
        }
        return { insightId: args.insightId, referenced: true };
      } catch (err) {
        return { error: `Failed to reference insight: ${err}` };
      }
    },
  });

  return [
    searchInsights,
    createInsight,
    referenceInsight,
  ];
}
