// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  AuthError,
  SYSTEM_USER_ID,
  type AuthProvider,
  type ProfileEnricher,
  type UserProfile,
} from "shared";
import { ANONYMOUS_USER, type AuthenticatedUser } from "./types.js";
import type { UserStore } from "./user-store.js";

/**
 * Paths that never require (or attempt) authentication. These are
 * infrastructure/metadata endpoints that must stay reachable by probes and
 * tooling without a token.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/ready",
  "/about",
  "/api/v1/version",
  "/openapi.json",
]);

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // Swagger UI serves several sub-paths under /api-docs.
  return path === "/api-docs" || path.startsWith("/api-docs/");
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

export interface AuthMiddlewareDeps {
  /** The configured token verifier, or null when auth is not configured. */
  getProvider: () => AuthProvider | null;
  /** The configured profile enricher, or null. */
  getEnricher: () => ProfileEnricher | null;
  /** The user store used for JIT provisioning, or null when auth is disabled. */
  getUserStore: () => UserStore | null;
}

/**
 * Identity-only authentication middleware (non-breaking).
 *
 * Behaviour:
 * - Public paths skip auth entirely.
 * - No provider configured, or no bearer token → **anonymous** principal, so
 *   existing unauthenticated callers (e.g. the report-generator worker) keep
 *   working unchanged.
 * - A bearer token that fails verification → **401** (a bad token is a client
 *   error; a *missing* token is not).
 * - A configured provider without its user store → **503** (fail closed).
 * - A valid token → the user is JIT-provisioned and `req.user` is set. A
 *   disabled user → **403**; the reserved `system` id → **401**.
 *
 * No route-level permission checks are performed here — that is deferred to the
 * RBAC milestone.
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps): RequestHandler {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      if (isPublicPath(req.path)) {
        next();
        return;
      }

      const provider = deps.getProvider();
      const token = extractBearerToken(req);

      // Auth not configured, or anonymous caller → non-breaking anonymous.
      if (!provider || !token) {
        req.user = ANONYMOUS_USER;
        next();
        return;
      }

      const userStore = deps.getUserStore();
      if (!userStore) {
        res.status(503).json({ error: "Authentication service unavailable" });
        return;
      }

      let identity;
      try {
        identity = await provider.verifyAccessToken(token);
      } catch (err) {
        if (err instanceof AuthError) {
          res
            .status(401)
            .json({ error: "Invalid or expired token", code: err.code });
          return;
        }
        throw err;
      }

      const enricher = deps.getEnricher();
      const profile: UserProfile = enricher
        ? await enricher.enrich(identity, token)
        : {
            email: identity.email,
            displayName: identity.displayName,
            emailVerified: identity.emailVerified,
          };

      const user = await userStore.upsertOnLogin(identity, profile);

      if (user.disabledAt) {
        res.status(403).json({ error: "User is disabled" });
        return;
      }
      if (user._id === SYSTEM_USER_ID) {
        res.status(401).json({ error: "Invalid principal" });
        return;
      }

      const principal: AuthenticatedUser = {
        id: user._id,
        isAuthenticated: true,
        role: user.role,
        email: user.email,
        displayName: user.displayName,
        idp: user.idp,
        idpTenant: user.idpTenant,
        idpSubject: user.idpSubject,
      };
      req.user = principal;
      next();
    } catch (err) {
      next(err);
    }
  };
}
