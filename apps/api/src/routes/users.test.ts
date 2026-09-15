// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { AuthError, type VerifiedIdentity } from "shared";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";
import { UserAccessError, type UserAccessService } from "../auth/user-access-resolver.js";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({ ready: true, applied: ["001"], pending: [] }),
}));
vi.mock("../llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generateCriteriaPrompt: vi.fn(),
}));
vi.mock("../prompt-feature-llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generatePromptFeaturePrompt: vi.fn(),
  extractPromptFeatures: vi.fn(),
}));
vi.mock("../task-prompt-llm.js", () => ({
  isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false),
  generateTaskPrompt: vi.fn(),
}));

const identity: VerifiedIdentity = {
  idp: "entra",
  idpTenant: "tenant-1",
  idpSubject: "subject-1",
  email: "user@example.com",
  displayName: "Test User",
  emailVerified: true,
};
const principal = {
  id: "user-uuid-1",
  role: "user",
  isAuthenticated: true,
  ...identity,
};
const provider = {
  id: "entra",
  verifyAccessToken: vi.fn(async () => identity),
};
const resolver = {
  resolveExisting: vi.fn(async () => principal),
  enrollOnLogin: vi.fn(async () => principal),
} satisfies UserAccessService;

describe("GET /api/v1/users/me", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    provider.verifyAccessToken.mockResolvedValue(identity);
    resolver.resolveExisting.mockResolvedValue(principal);
    resolver.enrollOnLogin.mockResolvedValue(principal);
    _injectTestDependencies(createAllMockDependencies());
    _injectTestDependencies({ authProvider: provider, userAccessResolver: resolver });
  });

  it.each(["", "?login=true"])("rejects anonymous requests %s without writes", async (query) => {
    const res = await request(app).get(`/api/v1/users/me${query}`);
    expect(res.status).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
  });

  it.each(["", "?login=false"])("returns the resolved Scope identity without enrolling %s", async (query) => {
    const res = await request(app).get(`/api/v1/users/me${query}`).set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      id: "user-uuid-1",
      role: "user",
      email: "user@example.com",
      displayName: "Test User",
      idp: "entra",
      idpTenant: "tenant-1",
    });
    expect(provider.verifyAccessToken).toHaveBeenCalledExactlyOnceWith("token");
    expect(resolver.resolveExisting).toHaveBeenCalledExactlyOnceWith(identity);
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it("enrolls on explicit login without a preceding existing-user lookup", async () => {
    resolver.enrollOnLogin.mockResolvedValue({ ...principal, role: "admin" });
    const res = await request(app).get("/api/v1/users/me?login=true").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
    expect(resolver.enrollOnLogin).toHaveBeenCalledExactlyOnceWith(identity, "token");
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    expect(provider.verifyAccessToken).toHaveBeenCalledOnce();
  });

  it("never enrolls for HEAD even when login=true", async () => {
    const res = await request(app).head("/api/v1/users/me?login=true").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(resolver.resolveExisting).toHaveBeenCalledOnce();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it.each([
    "login=", "login=1", "login=TRUE", "login=garbage",
    "login=true&login=false", "login[]=true", "login[nested]=true",
  ])("rejects invalid query %s with no access lookup or enrollment", async (query) => {
    const res = await request(app).get(`/api/v1/users/me?${query}`).set("Authorization", "Bearer token");
    expect(res.status).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it.each(["", "?login=true"])("requires an initialized resolver %s", async (query) => {
    _injectTestDependencies({ userAccessResolver: null });
    const res = await request(app).get(`/api/v1/users/me${query}`).set("Authorization", "Bearer token");
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it.each(["", "?login=true"])("rejects bad tokens before access resolution %s", async (query) => {
    provider.verifyAccessToken.mockRejectedValue(new AuthError("invalid_token", "bad"));
    const res = await request(app).get(`/api/v1/users/me${query}`).set("Authorization", "Bearer token");
    expect(res.status).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it.each(["user_not_enrolled", "user_disabled"] as const)("reports %s on read", async (code) => {
    resolver.resolveExisting.mockRejectedValue(new UserAccessError(code));
    const res = await request(app).get("/api/v1/users/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(code);
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it("propagates login access denial and does not fall through to other middleware", async () => {
    resolver.enrollOnLogin.mockRejectedValue(new UserAccessError("user_disabled"));
    const res = await request(app).get("/api/v1/users/me?login=true").set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("user_disabled");
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
  });

  it("does not allow login query on another API route to enroll", async () => {
    const res = await request(app).get("/api/v1/feature-flags?login=true").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(resolver.resolveExisting).toHaveBeenCalledOnce();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });
});
