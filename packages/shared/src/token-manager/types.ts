// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Token Manager — Shared Type Definitions
 *
 * These types are shared between the Token Manager service and its clients
 * (workers, judge, API proxy).
 */

/**
 * The kind of credential stored (token format).
 */
export type TokenType =
  | "github-pat-classic"
  | "github-pat-fine-grained"
  | "github-oauth"
  | "github-oauth-cookie-state"
  | "anthropic-api-key"
  | "anthropic-oauth";

/**
 * What a token can do — derived from (type + detected scopes/permissions).
 * Workers acquire tokens by capability, not by type.
 */
export type TokenCapability =
  "github-models" | "copilot-models" | "copilot-sdk" | "copilot-cli" | "claude-code-cli";

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
  /** Auto-detected capabilities based on token type and validated scopes/permissions. */
  capabilities: TokenCapability[];
  /** Auto-derived: token-{type}-{_id.substring(0,8)} */
  secretName: string;
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastValidationStatus: TokenValidationStatus;
  lastValidationError?: string;
  enabled: boolean;
  /** Optional free-text annotation (e.g. "John's CI token"). */
  comment?: string;
  /** Number of times this token has been acquired via /acquire. */
  acquireCount: number;
  /** Timestamp of the last acquisition. */
  lastAcquiredAt?: Date;
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
  capability: TokenCapability;
  expiresAt?: Date;
}

/**
 * Result of validating a token against its provider's API.
 */
export interface TokenValidationResult {
  status: TokenValidationStatus;
  scopes?: string[];
  capabilities?: TokenCapability[];
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
 * Capabilities are auto-detected during validation — not user-specified.
 */
export interface CreateTokenRequest {
  type: TokenType;
  value: string;
  expiresAt?: string;
  enabled?: boolean;
  comment?: string;
}

/**
 * Request body for PUT /api/v1/tokens/:id.
 * Only metadata — secret value is immutable.
 */
export interface UpdateTokenRequest {
  enabled?: boolean;
  expiresAt?: string | null;
  comment?: string | null;
}

/**
 * Request body for POST /api/v1/tokens/acquire.
 */
export interface AcquireTokenRequest {
  capability: TokenCapability;
}

/**
 * Maps each TokenCapability to the environment variable that workers check
 * for a local fallback (e.g., Docker Compose with env vars).
 */
export const TOKEN_CAPABILITY_ENV_VARS: Record<TokenCapability, string> = {
  "copilot-sdk": "GITHUB_TOKEN",
  "copilot-cli": "GITHUB_TOKEN",
  "copilot-models": "GITHUB_TOKEN",
  "github-models": "GITHUB_TOKEN",
  "claude-code-cli": "ANTHROPIC_API_KEY",
};

/**
 * Derive the KeyVault secret name from a token's type and ID.
 */
export function deriveSecretName(type: TokenType, id: string): string {
  return `token-${type}-${id.substring(0, 8)}`;
}

// =============================================================================
// Accounts — credential storage for key-updater automation
// =============================================================================

/**
 * The kind of service account stored.
 */
export type AccountType = "github";

/**
 * Account metadata stored in MongoDB. Secret values (username, password,
 * totpUri) are stored as a single JSON blob in Azure KeyVault.
 */
export interface AccountDocument {
  _id: string;
  type: AccountType;
  /** Auto-derived: account-{type}-{_id.substring(0,8)} */
  secretName: string;
  enabled: boolean;
  /** Optional free-text annotation (e.g. "CI bot account"). */
  comment?: string;
  /** Number of times this account has been acquired via /acquire. */
  acquireCount: number;
  /** Timestamp of the last acquisition. */
  lastAcquiredAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

/**
 * The secret value stored in KeyVault for an account.
 * All fields are sensitive — none are stored in MongoDB.
 */
export interface AccountSecretValue {
  username: string;
  password: string;
  /** Full otpauth:// URI (preserves issuer, algorithm, digits, period). */
  totpUri: string;
}

/**
 * Request body for POST /api/v1/accounts.
 */
export interface CreateAccountRequest {
  type: AccountType;
  username: string;
  password: string;
  /** Full otpauth:// URI or bare base32 secret. */
  totpUri: string;
  enabled?: boolean;
  comment?: string;
}

/**
 * Request body for PUT /api/v1/accounts/:id.
 */
export interface UpdateAccountRequest {
  enabled?: boolean;
  comment?: string | null;
  /** If provided, rotates the secrets in KeyVault. */
  username?: string;
  password?: string;
  totpUri?: string;
}

/**
 * Request body for POST /api/v1/accounts/acquire.
 */
export interface AcquireAccountRequest {
  type: AccountType;
}

/**
 * Response from POST /api/v1/accounts/acquire.
 * Returns the account's secret credentials.
 */
export interface AcquireAccountResponse {
  accountId: string;
  type: AccountType;
  username: string;
  password: string;
  totpUri: string;
}

/**
 * Derive the KeyVault secret name from an account's type and ID.
 */
export function deriveAccountSecretName(type: AccountType, id: string): string {
  return `account-${type}-${id.substring(0, 8)}`;
}
