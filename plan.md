# Plan: Add support for Claude Code Subscriptions OAuth token

**Issue:** https://github.com/growth-ecosystems/scope-core/issues/199
**Branch:** `feat/claude-oauth-token`
**Base:** `main`

## Context

Currently, only Anthropic API Keys (`sk-ant-*`) are supported for authenticating with the Anthropic API. The scope01 account has been set up for Claude Code subscriptions OAuth tokens, which use a different authentication mechanism (Bearer tokens via `Authorization` header instead of `x-api-key` header).

This feature adds a new token type `anthropic-oauth` alongside the existing `anthropic-api-key`, enabling the system to work with both authentication methods.

## Requirements (from issue)

- [ ] Should support the Anthropic model scanner
- [ ] Should support the Claude Code worker

## Architecture

### Auth Difference

| | API Key (`sk-ant-*`) | OAuth Token |
|---|---|---|
| **Header** | `x-api-key: <key>` | `Authorization: Bearer <token>` |
| **Prefix** | `sk-ant-` | (varies) |
| **Env var for Claude Code** | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` (Claude Code handles both) |

Claude Code CLI accepts OAuth tokens through the same `ANTHROPIC_API_KEY` environment variable — it auto-detects the token format. The key difference is how the token authenticates against the Anthropic REST API (model scanner, validation).

## Changes

### 1. Shared types (`packages/shared/src/token-manager/types.ts`)

- Add `"anthropic-oauth"` to the `TokenType` union
- The capability remains the same: `"claude-code-cli"`
- The env var fallback remains: `ANTHROPIC_API_KEY`

### 2. Capability derivation (`packages/shared/src/token-manager/capabilities.ts`)

- Add `case "anthropic-oauth": return ["claude-code-cli"]` — same capabilities as API key

### 3. Token validation (`apps/token-manager/src/token-validators.ts`)

- Add `case "anthropic-oauth"` to the `validateToken` switch
- New `validateAnthropicOAuth(token)` function that:
  - Calls `GET https://api.anthropic.com/v1/models` with `Authorization: Bearer <token>` header (instead of `x-api-key`)
  - Returns the same `TokenValidationResult` shape

### 4. Anthropic model scanner (`apps/model-scanners/anthropic/src/scan.ts`)

- Accept an optional `tokenType` parameter (defaults to `"anthropic-api-key"`)
- When `tokenType === "anthropic-oauth"`, use `Authorization: Bearer <token>` header
- When `tokenType === "anthropic-api-key"`, use `x-api-key: <token>` header (current behavior)

### 5. Anthropic model scanner entry point (`apps/model-scanners/anthropic/src/index.ts`)

- Pass the token type through to `scanAnthropicModels()` so it uses the correct auth header

### 6. Claude Code worker (`apps/workers/coder-acp-claude-code/src/index.ts`)

- No changes needed — Claude Code CLI accepts both API keys and OAuth tokens via `ANTHROPIC_API_KEY`
- The token manager already handles capability-based acquisition; as long as `anthropic-oauth` derives `claude-code-cli`, the worker will acquire whichever token is available

### 7. Portal — CreateToken page (`apps/portal/src/pages/CreateToken.tsx`)

- Add `"anthropic-oauth"` to `TOKEN_TYPES` array
- Add instructions for obtaining an OAuth token
- Add prefix validation (or skip prefix check for OAuth tokens since format varies)

### 8. Portal — types (`apps/portal/src/types.ts`)

- Add `"anthropic-oauth"` to the `TokenType` union
- Add `"anthropic-oauth": "Anthropic OAuth"` to `TOKEN_TYPE_LABELS`
- Add `"anthropic-oauth": ["claude-code-cli"]` to `TOKEN_TYPE_EXPECTED_CAPABILITIES`

### 9. Tests

- `packages/shared/src/token-manager/capabilities.test.ts` — add test for `anthropic-oauth` deriving `claude-code-cli`
- `apps/token-manager/src/token-validators.test.ts` (if exists) — add test for OAuth validation
- `apps/model-scanners/anthropic/src/scan.test.ts` (if exists) — add test for Bearer auth header

## File Change Summary

| File | Change |
|------|--------|
| `packages/shared/src/token-manager/types.ts` | Add `"anthropic-oauth"` to `TokenType` |
| `packages/shared/src/token-manager/capabilities.ts` | Add `"anthropic-oauth"` case |
| `packages/shared/src/token-manager/capabilities.test.ts` | Add test |
| `apps/token-manager/src/token-validators.ts` | Add OAuth validator |
| `apps/model-scanners/anthropic/src/scan.ts` | Support Bearer auth header |
| `apps/model-scanners/anthropic/src/index.ts` | Pass token type to scan |
| `apps/portal/src/types.ts` | Add type, label, capabilities |
| `apps/portal/src/pages/CreateToken.tsx` | Add UI for OAuth token type |
| `apps/workers/coder-acp-claude-code/src/index.ts` | No changes needed |

## Out of Scope

- Automated OAuth token refresh/rotation (no key-updater for Anthropic yet)
- OAuth flow UI in the portal (tokens are pasted manually, same as API keys)
- Changes to the `TOKEN_CAPABILITY_ENV_VARS` mapping (already correct)
