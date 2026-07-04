// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- Profile types ---

/**
 * Parse a profile spec string ("id" or "id@version") into its components.
 * Mirrors `parseExtensionSpec` but constrains the version to a positive integer.
 *
 * @example parseProfileSpec("abc-123") → { profileId: "abc-123" }
 * @example parseProfileSpec("abc-123@3") → { profileId: "abc-123", version: 3 }
 */
export function parseProfileSpec(spec: string): { profileId: string; version?: number } {
  const atIndex = spec.lastIndexOf("@");
  if (atIndex > 0) {
    const versionStr = spec.substring(atIndex + 1);
    const version = Number.parseInt(versionStr, 10);
    if (!Number.isInteger(version) || version <= 0 || String(version) !== versionStr) {
      throw new Error(`Invalid profile version in spec "${spec}" — expected a positive integer after "@"`);
    }
    return { profileId: spec.substring(0, atIndex), version };
  }
  return { profileId: spec };
}

/**
 * Profile document stored in MongoDB (`profiles` collection).
 *
 * A mutable identity record for a profile. Holds name, description, and
 * lifecycle fields. Configuration is stored in immutable ProfileVersionDocument
 * records in the `profile-versions` collection.
 */
export interface ProfileDocument {
  _id: string;                    // UUID — the profileId
  name: string;                   // Display name (e.g. "Azure Skills + Learn MCP")
  description?: string;           // Optional description
  latestVersion: number;          // Denormalized: current highest version number
  createdAt: Date;
  updatedAt?: Date;               // Updated when a new version is created or name/description changes
  deletedAt?: Date;               // Soft-delete the entire profile
}

/**
 * Profile version document stored in MongoDB (`profile-versions` collection).
 *
 * An **immutable** versioned snapshot of a profile's configuration.
 * Creating a new version auto-increments `version` and updates
 * `ProfileDocument.latestVersion` atomically.
 */
export interface ProfileVersionDocument {
  _id: string;                    // Composite: "<profileId>@<version>" (e.g. "abc123@3")
  profileId: string;              // FK → ProfileDocument._id
  version: number;                // Auto-incrementing per profileId (1, 2, 3, …)
  workerType: string;             // FK → CodingAgentDocument._id
  model: string;                  // Model identifier (required)
  reasoningEffort?: string;       // Reasoning effort level (e.g. "low", "medium", "high")
  options?: Record<string, unknown>; // Per-worker agent options bag (validated per-worker; e.g. { autopilot: true }). Merged with request options at submit (profile keys win).
  agentVersion?: string;          // Agent version string
  mcpServers?: string[];          // MCP server slugs
  skillRevisions?: string[];      // Pinned skill revision refs (e.g. "source/skillName@commitHash")
  extensions?: string[];          // Pinned extension IDs with version (e.g. "ms-python.python@2024.8.1")
  createdAt: Date;                // Immutable — no updatedAt
}
