// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- MCP Server types ---

/** Supported remote MCP transport types */
export type McpTransportType = "sse" | "http";

/** MCP server HTTP header (name-value pair) */
export interface McpServerHeader {
  name: string;
  value: string;
}

/** MCP server document stored in MongoDB */
export interface McpServerDocument {
  _id: string;                    // Slug identifier (e.g. "my-search-server")
  name: string;                   // Human-readable display name
  type: McpTransportType;         // Transport type
  url: string;                    // Server URL
  headers?: McpServerHeader[];    // Auth headers, API keys, etc.
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/** Resolved MCP server configuration passed to workers at runtime */
export interface McpServerConfig {
  type: McpTransportType;
  name: string;
  url: string;
  headers?: McpServerHeader[];
}
