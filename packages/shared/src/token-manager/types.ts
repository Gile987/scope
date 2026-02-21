// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Token Manager — Shared Type Definitions
 *
 * These types are shared between the Token Manager service and its clients
 * (workers, judge, API proxy).
 */

/**
 * The kind of credential stored.
 */
export type TokenType =
  | "github-pat"
  | "anthropic-api-key"
  | "github-models-api-key"
  | "github-oauth-state";

/**
 * What the token is used for — maps to a worker or service that consumes it.
 */
export type TokenUsage =
  | "copilot"
  | "claude-code"
  | "github-models"
  | "vscode-web";

/**
 * Validation status of a token.
 */
export type TokenValidationStatus =
  | "valid"
  | "invalid"
  | "expired"
  | "error"
  | "unknown";

/**
 * Token metadata stored in MongoDB. Secret values are never stored here —
 * they live in Azure KeyVault (or in-memory store for local dev).
 */
export interface TokenDocument {
  _id: string;
  type: TokenType;
  usage: TokenUsage;
  /** Auto-derived: token-{usage}-{_id.substring(0,8)} */
  secretName: string;
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastValidationStatus: TokenValidationStatus;
  lastValidationError?: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

/**
 * Response from POST /api/v1/tokens/acquire.
 * Only returned to internal callers (workers inside the cluster).
 */
export interface AcquireTokenResponse {
  value: string;
  tokenId: string;
  usage: TokenUsage;
  expiresAt?: Date;
}

/**
 * Result of validating a token against its provider's API.
 */
export interface TokenValidationResult {
  status: TokenValidationStatus;
  scopes?: string[];
  expiresAt?: Date;
  error?: string;
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: Date;
  };
}

/**
 * Request body for POST /api/v1/tokens.
 */
export interface CreateTokenRequest {
  type: TokenType;
  usage: TokenUsage;
  value: string;
  expiresAt?: string;
  enabled?: boolean;
}

/**
 * Request body for PUT /api/v1/tokens/:id.
 * Only metadata — secret value is immutable.
 */
export interface UpdateTokenRequest {
  enabled?: boolean;
  expiresAt?: string | null;
}

/**
 * Request body for POST /api/v1/tokens/acquire.
 */
export interface AcquireTokenRequest {
  usage: TokenUsage;
}

/**
 * Maps each TokenUsage to the environment variable that workers check
 * for a local fallback (e.g., Docker Compose with env vars).
 */
export const TOKEN_USAGE_ENV_VARS: Record<TokenUsage, string> = {
  copilot: "GITHUB_TOKEN",
  "claude-code": "ANTHROPIC_API_KEY",
  "github-models": "GITHUB_MODELS_API_KEY",
  "vscode-web": "GITHUB_AUTH_STATE",
};

/**
 * Derive the KeyVault secret name from a token's usage and ID.
 */
export function deriveSecretName(usage: TokenUsage, id: string): string {
  return `token-${usage}-${id.substring(0, 8)}`;
}
