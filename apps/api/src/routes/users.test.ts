// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { UserDocument, VerifiedIdentity } from "shared";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";

// index.ts imports these at module load — stub them as the other suites do.
vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: ["001"],
    pending: [],
  }),
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

const IDENTITY: VerifiedIdentity = {
  idp: "entra",
  idpTenant: "tenant-1",
  idpSubject: "subject-1",
  email: "user@example.com",
  displayName: "Test User",
  emailVerified: true,
};

function authUser(): UserDocument {
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
  } as UserDocument;
}

describe("GET /api/v1/users/me", () => {
  let mocks: ReturnType<typeof createAllMockDependencies>;

  beforeAll(() => {
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  it("returns 401 for an anonymous caller", async () => {
    const res = await request(app).get("/api/v1/users/me");
    expect(res.status).toBe(401);
  });

  it("returns the identity for an authenticated caller", async () => {
    _injectTestDependencies({
      authProvider: { id: "entra", verifyAccessToken: vi.fn(async () => IDENTITY) },
      profileEnricher: null,
      userStore: {
        upsertOnLogin: vi.fn(async () => authUser()),
        findById: vi.fn(),
      } as never,
    });

    const res = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-uuid-1",
      role: "user",
      email: "user@example.com",
      displayName: "Test User",
      idp: "entra",
      idpTenant: "tenant-1",
    });
  });

  it("returns 503 when authentication persistence is unavailable", async () => {
    _injectTestDependencies({
      authProvider: {
        id: "entra",
        verifyAccessToken: vi.fn(async () => IDENTITY),
      },
      profileEnricher: null,
      userStore: null,
    });

    const res = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Authentication service unavailable" });
  });

  it("returns 401 when a bad token is presented", async () => {
    const { AuthError } = await import("shared");
    _injectTestDependencies({
      authProvider: {
        id: "entra",
        verifyAccessToken: vi.fn(async () => {
          throw new AuthError("invalid_token", "bad");
        }),
      },
      userStore: {
        upsertOnLogin: vi.fn(),
        findById: vi.fn(),
      } as never,
    });

    const res = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", "Bearer bad-token");

    expect(res.status).toBe(401);
  });
});
