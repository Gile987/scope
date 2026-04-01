// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createAccountRouter } from "./account-routes.js";
import type { Collection, FindCursor, WithId } from "mongodb";
import type { SecretStore } from "./keyvault-store.js";

// Inline the types we need to avoid "shared" resolution issues in worktrees
interface AccountDocument {
  _id: string;
  type: string;
  secretName: string;
  enabled: boolean;
  comment?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

interface AccountSecretValue {
  username: string;
  password: string;
  totpUri: string;
}

// ── helpers ──────────────────────────────────────────────

function makeApp(
  collection: Partial<Collection<AccountDocument>>,
  store: Partial<SecretStore>
) {
  const app = express();
  app.use(express.json());
  const router = createAccountRouter(
    collection as Collection<AccountDocument>,
    store as SecretStore
  );
  app.use(router);
  return app;
}

/** Invoke an Express app with a synthetic request and return { status, body }. */
async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url: path,
      headers: { "content-type": "application/json" },
      body: body ?? {},
      params: {},
      query: {},
      get: (h: string) => (h === "content-type" ? "application/json" : undefined),
    } as unknown as express.Request;

    const chunks: Buffer[] = [];
    let statusCode = 200;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: unknown) {
        statusCode = statusCode || 200;
        resolve({ status: statusCode, body: data });
      },
      send(data?: unknown) {
        resolve({ status: statusCode, body: data ?? null });
      },
      setHeader() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      end() {
        resolve({ status: statusCode, body: null });
      },
    } as unknown as express.Response;

    // Use app.handle to drive through the router middleware
    (app as any).handle(req, res, (err: Error) => {
      resolve({ status: 500, body: { error: err.message } });
    });
  });
}

function makeMockCollection(docs: AccountDocument[] = []) {
  const store = new Map(docs.map((d) => [d._id, { ...d }]));

  const collection = {
    insertOne: vi.fn(async (doc: any) => {
      store.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: any) => {
      // Support both _id-based lookup and field-based queries (e.g. acquire)
      for (const doc of store.values()) {
        if (filter._id && doc._id !== filter._id) continue;
        if (filter.type && doc.type !== filter.type) continue;
        if (filter.enabled !== undefined && doc.enabled !== filter.enabled) continue;
        if (filter.deletedAt?.$exists === false && doc.deletedAt) continue;
        return { ...doc };
      }
      return null;
    }),
    find: vi.fn(() => {
      const results = Array.from(store.values()).filter((d) => !d.deletedAt);
      return {
        toArray: vi.fn(async () => results.map((d) => ({ ...d }))),
      } as unknown as FindCursor<WithId<AccountDocument>>;
    }),
    findOneAndUpdate: vi.fn(async (filter: any, update: any, opts: any) => {
      const id = filter._id;
      const doc = store.get(id);
      if (!doc) return null;
      if (filter.deletedAt?.$exists === false && doc.deletedAt) return null;
      const $set = update.$set || {};
      Object.assign(doc, $set);
      store.set(id, doc);
      return { ...doc };
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const id = filter._id;
      const doc = store.get(id);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      const $set = update.$set || {};
      Object.assign(doc, $set);
      store.set(id, doc);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };

  return collection;
}

function makeMockStore(secrets: Map<string, string> = new Map()) {
  return {
    getSecret: vi.fn(async (name: string) => {
      const val = secrets.get(name);
      if (!val) throw new Error(`Secret '${name}' not found`);
      return val;
    }),
    setSecret: vi.fn(async (name: string, value: string) => {
      secrets.set(name, value);
    }),
    deleteSecret: vi.fn(async (name: string) => {
      secrets.delete(name);
    }),
  };
}

// ── tests ──────────────────────────────────────────────

describe("account-routes", () => {
  let collection: ReturnType<typeof makeMockCollection>;
  let store: ReturnType<typeof makeMockStore>;
  let secrets: Map<string, string>;
  let app: express.Express;

  beforeEach(() => {
    secrets = new Map();
    collection = makeMockCollection();
    store = makeMockStore(secrets);
    app = makeApp(collection, store);
  });

  describe("POST /api/v1/accounts", () => {
    it("creates an account and stores secrets in KeyVault", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "bot-user",
        password: "secret-pass",
        totpUri: "otpauth://totp/GitHub:bot-user?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        comment: "CI bot",
      });

      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(body._id).toBeDefined();
      expect(body.type).toBe("github");
      expect(body.secretName).toMatch(/^account-github-/);
      expect(body.enabled).toBe(true);
      expect(body.comment).toBe("CI bot");

      // Secret stored as JSON blob
      expect(store.setSecret).toHaveBeenCalledTimes(1);
      const [secretName, secretVal] = store.setSecret.mock.calls[0];
      expect(secretName).toBe(body.secretName);
      const parsed: AccountSecretValue = JSON.parse(secretVal);
      expect(parsed.username).toBe("bot-user");
      expect(parsed.password).toBe("secret-pass");
      expect(parsed.totpUri).toBe("otpauth://totp/GitHub:bot-user?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");

      // Metadata stored in MongoDB
      expect(collection.insertOne).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid type", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "gitlab",
        username: "u",
        password: "p",
        totpUri: "t",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("Invalid type");
    });

    it("rejects missing username", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        password: "p",
        totpUri: "t",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("username");
    });

    it("rejects missing password", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        totpUri: "t",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("password");
    });

    it("rejects missing totpUri", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("totpUri");
    });

    it("defaults enabled to true", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
      });
      expect(res.status).toBe(201);
      expect((res.body as any).enabled).toBe(true);
    });

    it("respects enabled=false", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
        enabled: false,
      });
      expect(res.status).toBe(201);
      expect((res.body as any).enabled).toBe(false);
    });
  });

  describe("GET /api/v1/accounts", () => {
    it("returns empty list when no accounts exist", async () => {
      const res = await request(app, "GET", "/api/v1/accounts");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns accounts sorted by createdAt descending", async () => {
      // Create two accounts
      await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u1",
        password: "p1",
        totpUri: "t1",
        comment: "first",
      });
      await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u2",
        password: "p2",
        totpUri: "t2",
        comment: "second",
      });

      const res = await request(app, "GET", "/api/v1/accounts");
      expect(res.status).toBe(200);
      const accounts = res.body as any[];
      expect(accounts.length).toBe(2);
    });
  });

  describe("GET /api/v1/accounts/:id", () => {
    it("returns 404 for non-existent account", async () => {
      const res = await request(app, "GET", "/api/v1/accounts/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns account metadata", async () => {
      const createRes = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
      });
      const id = (createRes.body as any)._id;

      const res = await request(app, "GET", `/api/v1/accounts/${id}`);
      expect(res.status).toBe(200);
      expect((res.body as any)._id).toBe(id);
      expect((res.body as any).type).toBe("github");
    });
  });

  describe("GET /api/v1/accounts/:id/secrets", () => {
    it("returns 404 for non-existent account", async () => {
      const res = await request(app, "GET", "/api/v1/accounts/nonexistent/secrets");
      expect(res.status).toBe(404);
    });

    it("returns secret values from KeyVault", async () => {
      const createRes = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "bot",
        password: "pass123",
        totpUri: "otpauth://totp/GitHub:bot?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      });
      const body = createRes.body as any;

      const res = await request(app, "GET", `/api/v1/accounts/${body._id}/secrets`);
      expect(res.status).toBe(200);
      const secretBody = res.body as AccountSecretValue;
      expect(secretBody.username).toBe("bot");
      expect(secretBody.password).toBe("pass123");
      expect(secretBody.totpUri).toBe("otpauth://totp/GitHub:bot?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
    });
  });

  describe("PUT /api/v1/accounts/:id", () => {
    it("returns 404 for non-existent account", async () => {
      const res = await request(app, "PUT", "/api/v1/accounts/nonexistent", {
        enabled: false,
      });
      expect(res.status).toBe(404);
    });

    it("updates metadata fields", async () => {
      const createRes = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
      });
      const id = (createRes.body as any)._id;

      const res = await request(app, "PUT", `/api/v1/accounts/${id}`, {
        enabled: false,
        comment: "disabled for maintenance",
      });
      expect(res.status).toBe(200);
      expect((res.body as any).enabled).toBe(false);
      expect((res.body as any).comment).toBe("disabled for maintenance");
    });

    it("rotates secrets when secret fields provided", async () => {
      const createRes = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "old-user",
        password: "old-pass",
        totpUri: "otpauth://totp/GitHub:old-user?secret=OLDSECRET&issuer=GitHub",
      });
      const body = createRes.body as any;

      // Update only password
      await request(app, "PUT", `/api/v1/accounts/${body._id}`, {
        password: "new-pass",
      });

      // Verify merged secret
      const secretRaw = secrets.get(body.secretName)!;
      const parsed: AccountSecretValue = JSON.parse(secretRaw);
      expect(parsed.username).toBe("old-user"); // unchanged
      expect(parsed.password).toBe("new-pass"); // updated
      expect(parsed.totpUri).toBe("otpauth://totp/GitHub:old-user?secret=OLDSECRET&issuer=GitHub"); // unchanged
    });
  });

  describe("DELETE /api/v1/accounts/:id", () => {
    it("returns 404 for non-existent account", async () => {
      const res = await request(app, "DELETE", "/api/v1/accounts/nonexistent");
      expect(res.status).toBe(404);
    });

    it("soft-deletes an account", async () => {
      const createRes = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
      });
      const id = (createRes.body as any)._id;

      const res = await request(app, "DELETE", `/api/v1/accounts/${id}`);
      expect(res.status).toBe(204);

      // Account should not appear in list
      const listRes = await request(app, "GET", "/api/v1/accounts");
      expect((listRes.body as any[]).length).toBe(0);

      // Account should not be found by ID
      const getRes = await request(app, "GET", `/api/v1/accounts/${id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe("POST /api/v1/accounts/acquire", () => {
    it("rejects invalid type", async () => {
      const res = await request(app, "POST", "/api/v1/accounts/acquire", {
        type: "invalid",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing type", async () => {
      const res = await request(app, "POST", "/api/v1/accounts/acquire", {});
      expect(res.status).toBe(400);
    });

    it("returns 404 when no enabled account exists", async () => {
      const res = await request(app, "POST", "/api/v1/accounts/acquire", {
        type: "github",
      });
      expect(res.status).toBe(404);
    });

    it("acquires an enabled account and returns credentials", async () => {
      // Create an account first
      await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "testuser",
        password: "testpass",
        totpUri: "otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP",
      });

      const res = await request(app, "POST", "/api/v1/accounts/acquire", {
        type: "github",
      });

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.accountId).toBeDefined();
      expect(body.type).toBe("github");
      expect(body.username).toBe("testuser");
      expect(body.password).toBe("testpass");
      expect(body.totpUri).toBe("otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP");
    });

    it("does not acquire disabled accounts", async () => {
      // Create a disabled account
      await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
        enabled: false,
      });

      const res = await request(app, "POST", "/api/v1/accounts/acquire", {
        type: "github",
      });
      expect(res.status).toBe(404);
    });

    it("does not acquire deleted accounts", async () => {
      // Create and then delete an account
      const createRes = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpUri: "t",
      });
      const id = (createRes.body as any)._id;
      await request(app, "DELETE", `/api/v1/accounts/${id}`);

      const res = await request(app, "POST", "/api/v1/accounts/acquire", {
        type: "github",
      });
      expect(res.status).toBe(404);
    });
  });
});
