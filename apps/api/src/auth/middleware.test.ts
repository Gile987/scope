// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  AuthError,
  type AuthProvider,
  type ProfileEnricher,
  type UserDocument,
  type UserProfile,
  type VerifiedIdentity,
} from "shared";
import { createAuthMiddleware, type AuthMiddlewareDeps } from "./middleware.js";
import type { UserStore } from "./user-store.js";
import type { AuthenticatedUser } from "./types.js";

// ── Fakes ─────────────────────────────────────────────────────────────────

const IDENTITY: VerifiedIdentity = {
  idp: "entra",
  idpTenant: "tenant-1",
  idpSubject: "subject-1",
  email: "user@example.com",
  displayName: "Test User",
  emailVerified: true,
};

function fakeProvider(
  impl: (token: string) => Promise<VerifiedIdentity>,
): AuthProvider {
  return { id: "entra", verifyAccessToken: vi.fn(impl) };
}

function fakeStore(
  upsert: (i: VerifiedIdentity, p: UserProfile) => Promise<UserDocument>,
): UserStore {
  return {
    upsertOnLogin: vi.fn(upsert),
    findById: vi.fn(),
  } as unknown as UserStore;
}

function userDoc(overrides: Partial<UserDocument> = {}): UserDocument {
  return {
    _id: "user-uuid-1",
    idp: "entra",
    idpTenant: "tenant-1",
    idpSubject: "subject-1",
    email: "user@example.com",
    displayName: "Test User",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UserDocument;
}

interface FakeCtx {
  req: Request;
  res: Response & { statusCode?: number; body?: unknown };
  next: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: { path?: string; authorization?: string } = {}): FakeCtx {
  const req = {
    path: opts.path ?? "/api/v1/users/me",
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as Request;

  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  } as unknown as Response & { statusCode?: number; body?: unknown };

  return { req, res, next: vi.fn() };
}

function deps(overrides: Partial<AuthMiddlewareDeps> = {}): AuthMiddlewareDeps {
  return {
    getProvider: () => null,
    getEnricher: () => null,
    getUserStore: () => null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("createAuthMiddleware", () => {
  it("skips public paths without touching the provider", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const mw = createAuthMiddleware(deps({ getProvider: () => provider }));
    const { req, res, next } = makeCtx({ path: "/health" });

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("treats a request with no provider as anonymous", async () => {
    const mw = createAuthMiddleware(deps());
    const { req, res, next } = makeCtx({ authorization: "Bearer abc" });

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.isAuthenticated).toBe(false);
    expect(req.user?.id).toBe("anonymous");
  });

  it("treats a request with no bearer token as anonymous", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const mw = createAuthMiddleware(deps({ getProvider: () => provider }));
    const { req, res, next } = makeCtx();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.isAuthenticated).toBe(false);
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("responds 401 when the token fails verification", async () => {
    const provider = fakeProvider(async () => {
      throw new AuthError("expired_token", "token expired");
    });
    const store = fakeStore(async () => userDoc());
    const mw = createAuthMiddleware(
      deps({ getProvider: () => provider, getUserStore: () => store }),
    );
    const { req, res, next } = makeCtx({ authorization: "Bearer bad" });

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { code?: string }).code).toBe("expired_token");
    expect(req.user).toBeUndefined();
  });

  it("responds 503 when token verification cannot retrieve JWKS", async () => {
    const provider = fakeProvider(async () => {
      throw new AuthError(
        "service_unavailable",
        "Authentication key service is unavailable",
      );
    });
    const store = fakeStore(async () => userDoc());
    const mw = createAuthMiddleware(
      deps({ getProvider: () => provider, getUserStore: () => store }),
    );
    const { req, res, next } = makeCtx({ authorization: "bearer token" });

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "Authentication service unavailable",
      code: "service_unavailable",
    });
    expect(store.upsertOnLogin).not.toHaveBeenCalled();
  });

  it("sets req.user and JIT-upserts on a valid token", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const store = fakeStore(async () => userDoc());
    const mw = createAuthMiddleware(
      deps({ getProvider: () => provider, getUserStore: () => store }),
    );
    const { req, res, next } = makeCtx({ authorization: "Bearer good" });

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(store.upsertOnLogin).toHaveBeenCalledOnce();
    const user = req.user as AuthenticatedUser;
    expect(user.isAuthenticated).toBe(true);
    expect(user.id).toBe("user-uuid-1");
    expect(user.role).toBe("user");
    expect(user.email).toBe("user@example.com");
    expect(user.displayName).toBe("Test User");
  });

  it("passes the enriched profile to the store", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const enricher: ProfileEnricher = {
      id: "graph",
      enrich: vi.fn(async () => ({
        email: "graph@example.com",
        displayName: "Graph Name",
      })),
    };
    let captured: UserProfile | undefined;
    const store = fakeStore(async (_i, p) => {
      captured = p;
      return userDoc({ email: p.email, displayName: p.displayName });
    });
    const mw = createAuthMiddleware(
      deps({
        getProvider: () => provider,
        getEnricher: () => enricher,
        getUserStore: () => store,
      }),
    );
    const { req, res, next } = makeCtx({ authorization: "Bearer good" });

    await mw(req, res, next);

    expect(enricher.enrich).toHaveBeenCalledOnce();
    expect(captured?.email).toBe("graph@example.com");
    expect(req.user?.email).toBe("graph@example.com");
  });

  it("responds 403 for a disabled user", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const store = fakeStore(async () => userDoc({ disabledAt: new Date() }));
    const mw = createAuthMiddleware(
      deps({ getProvider: () => provider, getUserStore: () => store }),
    );
    const { req, res, next } = makeCtx({ authorization: "Bearer good" });

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(req.user).toBeUndefined();
  });

  it("responds 401 when the resolved id is the reserved system id", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const store = fakeStore(async () => userDoc({ _id: "system" }));
    const mw = createAuthMiddleware(
      deps({ getProvider: () => provider, getUserStore: () => store }),
    );
    const { req, res, next } = makeCtx({ authorization: "Bearer good" });

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("responds 503 when auth is configured without a user store", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const mw = createAuthMiddleware(deps({ getProvider: () => provider }));
    const { req, res, next } = makeCtx({ authorization: "Bearer good" });

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(req.user).toBeUndefined();
  });

  it("accepts a case-insensitive bearer scheme", async () => {
    const provider = fakeProvider(async () => IDENTITY);
    const store = fakeStore(async () => userDoc());
    const mw = createAuthMiddleware(
      deps({ getProvider: () => provider, getUserStore: () => store }),
    );
    const { req, res, next } = makeCtx({ authorization: "bearer good" });

    await mw(req, res, next);

    expect(store.upsertOnLogin).toHaveBeenCalledOnce();
    expect(req.user?.isAuthenticated).toBe(true);
  });
});
