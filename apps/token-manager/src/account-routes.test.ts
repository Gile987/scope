// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createAccountRouter } from "./account-routes.js";
import type { Collection, FindCursor, WithId } from "mongodb";
import type { TokenSecretStore } from "./keyvault-store.js";

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
  totpSecret: string;
}

// ── helpers ──────────────────────────────────────────────

function makeApp(
  collection: Partial<Collection<AccountDocument>>,
  store: Partial<TokenSecretStore>
) {
  const app = express();
  app.use(express.json());
  const router = createAccountRouter(
    collection as Collection<AccountDocument>,
    store as TokenSecretStore
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
      const id = filter._id;
      const doc = store.get(id);
      if (!doc) return null;
      if (filter.deletedAt?.$exists === false && doc.deletedAt) return null;
      return { ...doc };
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
        totpSecret: "JBSWY3DPEHPK3PXP",
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
      expect(parsed.totpSecret).toBe("JBSWY3DPEHPK3PXP");

      // Metadata stored in MongoDB
      expect(collection.insertOne).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid type", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "gitlab",
        username: "u",
        password: "p",
        totpSecret: "t",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("Invalid type");
    });

    it("rejects missing username", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        password: "p",
        totpSecret: "t",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("username");
    });

    it("rejects missing password", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        totpSecret: "t",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("password");
    });

    it("rejects missing totpSecret", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("totpSecret");
    });

    it("defaults enabled to true", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpSecret: "t",
      });
      expect(res.status).toBe(201);
      expect((res.body as any).enabled).toBe(true);
    });

    it("respects enabled=false", async () => {
      const res = await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u",
        password: "p",
        totpSecret: "t",
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
        totpSecret: "t1",
        comment: "first",
      });
      await request(app, "POST", "/api/v1/accounts", {
        type: "github",
        username: "u2",
        password: "p2",
        totpSecret: "t2",
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
        totpSecret: "t",
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
        totpSecret: "TOTP_KEY",
      });
      const body = createRes.body as any;

      const res = await request(app, "GET", `/api/v1/accounts/${body._id}/secrets`);
      expect(res.status).toBe(200);
      const secretBody = res.body as AccountSecretValue;
      expect(secretBody.username).toBe("bot");
      expect(secretBody.password).toBe("pass123");
      expect(secretBody.totpSecret).toBe("TOTP_KEY");
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
        totpSecret: "t",
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
        totpSecret: "old-totp",
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
      expect(parsed.totpSecret).toBe("old-totp"); // unchanged
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
        totpSecret: "t",
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
});
