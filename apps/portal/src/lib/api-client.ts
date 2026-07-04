// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared HTTP transport for the Portal, built on
 * [`ky`](https://github.com/sindresorhus/ky).
 *
 * The Portal's API facade ({@link file://./api.ts}) and blob-fetching hooks talk
 * to the Scope API through this single {@link apiClient} instance instead of
 * calling `fetch` directly. Centralizing the transport gives us one place to:
 *  - inject `Authorization: Bearer` once Portal auth lands (auth-rbac.md
 *    subtask 8) via the pluggable {@link setApiTokenProvider} seam,
 *  - later opt into retry/backoff or request logging.
 *
 * The instance mirrors the CLI client's configuration: it never throws on
 * non-2xx (`throwHttpErrors: false`) so call sites keep their existing
 * `response.ok` handling, has no client-side timeout, and does not retry — the
 * facade owns any higher-level behavior. Auth is injected in a `beforeRequest`
 * hook and never clobbers a caller-supplied `Authorization` header.
 *
 * The root-level `/ready` health probe (`api.getReadiness`) intentionally keeps
 * using `fetch` directly: it is unauthenticated, lives outside `/api/v1`, and
 * needs bespoke `503` handling.
 *
 * See [docs/architecture/auth-rbac.md](../../../../docs/architecture/auth-rbac.md) §7.
 */
import ky, { type BeforeRequestHook, type KyInstance } from "ky";

/**
 * Resolves the bearer token to attach to outgoing Scope API requests. Returning
 * `undefined` means "no token available" — the request goes out unauthenticated.
 */
export type TokenProvider = () => string | undefined | Promise<string | undefined>;

// Portal auth (subtask 8) is not wired yet; default to no token. The Portal is
// served same-origin behind the API today, so requests are authenticated by the
// session cookie until bearer auth lands.
let tokenProvider: TokenProvider = () => undefined;

/** Override how bearer tokens are resolved (wired by Portal auth — subtask 8). */
export function setApiTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/** Reset the token provider to its default. Primarily for tests. */
export function resetApiClient(): void {
  tokenProvider = () => undefined;
}

const authHook: BeforeRequestHook = async ({ request }) => {
  if (request.headers.has("authorization")) return;
  const token = await tokenProvider();
  if (token) request.headers.set("authorization", `Bearer ${token}`);
};

/** Shared `ky` instance backing the Portal API facade and blob fetches. */
export const apiClient: KyInstance = ky.create({
  // Call sites do their own `response.ok` handling — never throw on non-2xx.
  throwHttpErrors: false,
  // No client-side timeout; cancellation is handled per-request via `signal`.
  timeout: false,
  // Preserve current single-attempt behavior; no automatic retries.
  retry: 0,
  hooks: { beforeRequest: [authHook] },
});
