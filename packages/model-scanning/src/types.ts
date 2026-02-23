// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Model scanning shared types.
 *
 * These are used by both the model-scanning package (reconciliation, utilities)
 * and the per-provider scanner apps.
 */

/**
 * A model discovered by a provider scanner (before persistence).
 */
export interface ScannedModel {
  /** Model identifier as returned by the provider API (e.g. "gpt-4.1"). */
  id: string;
  /** Provider-reported date when the model became available, if known. */
  providerAvailableFrom?: Date;
  /** Provider-reported planned end-of-life / deprecation date, if known. */
  providerEndOfLife?: Date;
  /** Any additional provider-specific metadata worth keeping. */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a single provider scan.
 */
export interface ScanResult {
  /** Provider identifier (e.g. "github-copilot", "anthropic"). */
  provider: string;
  /** Models discovered in this scan. */
  models: ScannedModel[];
  /** Timestamp when the scan was performed. */
  scannedAt: Date;
}

/**
 * MongoDB document for a scanned model.
 * Tracks lifecycle: when the model was first seen, last seen, and when it
 * disappeared from the provider's API.
 */
export interface ModelDocument {
  /** Model identifier (e.g. "gpt-4.1"). Compound key with agentId. */
  _id: string;
  /** Provider identifier (e.g. "github-copilot", "anthropic"). */
  provider: string;
  /** Which coding agent this model was discovered for. */
  agentId: string;
  /** First time our scanner discovered this model. */
  firstSeenAt: Date;
  /** Last scan where this model was still present. */
  lastSeenAt: Date;
  /** Set when a previously-seen model no longer appears in the provider's API. */
  disappearedAt?: Date;
  /** Provider-reported date when the model became available. */
  providerAvailableFrom?: Date;
  /** Provider-reported planned end-of-life / deprecation date. */
  providerEndOfLife?: Date;
  /** Any additional provider-specific metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Report returned by the reconciliation process.
 */
export interface ReconcileReport {
  /** Model IDs that appeared for the first time. */
  added: string[];
  /** Model IDs that were previously seen but are no longer in the scan. */
  removed: string[];
  /** Model IDs that were already known and still present. */
  unchanged: string[];
}

/**
 * Request body for POST /api/v1/models/sync.
 */
export interface ModelSyncRequest {
  agentId: string;
  provider: string;
  models: ScannedModel[];
  scannedAt: string; // ISO 8601
}

/**
 * Agent definition used for upserting via the API.
 */
export interface AgentDefinition {
  _id: string;
  name: string;
  description?: string;
  supportedModels: string[];
  defaultModel?: string;
}
