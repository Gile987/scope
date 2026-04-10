// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createMcpEnvVarRouter } from "./mcp-env-var-routes.js";
import type { Collection, FindCursor, WithId } from "mongodb";
import type { SecretStore } from "./keyvault-store.js";

interface McpEnvVarDocument {
  _id: string;
  mcpName: string;
  key: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeApp(
  collection: Partial<Collection<McpEnvVarDocument>>,
  store: Partial<SecretStore>,
) {
  const app = express();
  app.use(express.json());
  const router = createMcpEnvVarRouter(
    collection as Collection<McpEnvVarDocument>,
    store as SecretStore,
  );
  app.use(router);
  return app;
}

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const [pathname, querystring] = path.split("?");
    const query: Record<string, string> = {};
    if (querystring) {
      for (const part of querystring.split("&")) {
        const [k, v] = part.split("=");
        query[k] = v ?? "";
      }
    }

    const req = {
      method: method.toUpperCase(),
      url: path,
      path: pathname,
      headers: { "content-type": "application/json" },
      body: body ?? {},
      params: {},
      query,
      get: (h: string) => (h === "content-type" ? "application/json" : undefined),
    } as unknown as express.Request;

    let statusCode = 200;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: unknown) {
        resolve({ status: statusCode, body: data });
      },
      send(data?: unknown) {
        resolve({ status: statusCode, body: data ?? null });
      },
      end() {
        resolve({ status: statusCode, body: null });
      },
      setHeader() { return this; },
      getHeader() { return undefined; },
    } as unknown as express.Response;

    (app as any).handle(req, res, (err: Error) => {
      resolve({ status: 500, body: { error: err?.message ?? "unknown error" } });
    });
  });
}

function makeMockCollection(docs: McpEnvVarDocument[] = []) {
  const store = new Map(docs.map((d) => [d._id, { ...d }]));

  return {
    insertOne: vi.fn(async (doc: any) => {
      store.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: any) => {
      for (const doc of store.values()) {
        if (filter._id && doc._id !== filter._id) continue;
        if (filter.mcpName && doc.mcpName !== filter.mcpName) continue;
        return { ...doc };
      }
      return null;
    }),
    find: vi.fn((filter: any) => {
      const results = Array.from(store.values()).filter(
        (d) => !filter?.mcpName || d.mcpName === filter.mcpName,
      );
      return {
        toArray: vi.fn(async () => results.map((d) => ({ ...d }))),
      } as unknown as FindCursor<WithId<McpEnvVarDocument>>;
    }),
    deleteOne: vi.fn(async (filter: any) => {
      const id = filter._id;
      const deleted = store.delete(id);
      return { deletedCount: deleted ? 1 : 0 };
    }),
  };
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

// ── tests ────────────────────────────────────────────────────────────────────

describe("mcp-env-var-routes", () => {
  let collection: ReturnType<typeof makeMockCollection>;
  let store: ReturnType<typeof makeMockStore>;
  let app: express.Express;

  beforeEach(() => {
    collection = makeMockCollection();
    store = makeMockStore();
    app = makeApp(collection, store);
  });

  describe("POST /mcp/servers/:mcpName/env-vars", () => {
    it("stores the secret in KV and inserts a document (without value)", async () => {
      const res = await request(app, "POST", "/mcp/servers/my-server/env-vars", {
        key: "GITHUB_TOKEN",
        value: "ghp_test",
      });

      expect(res.status).toBe(201);
      expect(store.setSecret).toHaveBeenCalledOnce();
      expect(collection.insertOne).toHaveBeenCalledOnce();

      const body = res.body as any;
      expect(body.key).toBe("GITHUB_TOKEN");
      expect(body.mcpName).toBe("my-server");
      expect(body).not.toHaveProperty("value"); // value never returned
    });

    it("returns 400 if key is missing", async () => {
      const res = await request(app, "POST", "/mcp/servers/my-server/env-vars", { value: "val" });
      expect(res.status).toBe(400);
    });

    it("returns 400 if value is missing", async () => {
      const res = await request(app, "POST", "/mcp/servers/my-server/env-vars", { key: "KEY" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /mcp/servers/:mcpName/env-vars", () => {
    it("returns key metadata without values", async () => {
      collection = makeMockCollection([
        { _id: "abc", mcpName: "my-server", key: "GITHUB_TOKEN", createdAt: new Date(), updatedAt: new Date() },
      ]);
      app = makeApp(collection, store);

      const res = await request(app, "GET", "/mcp/servers/my-server/env-vars");

      expect(res.status).toBe(200);
      const body = res.body as any[];
      expect(body).toHaveLength(1);
      expect(body[0].key).toBe("GITHUB_TOKEN");
      expect(body[0]).not.toHaveProperty("value");
    });

    it("resolves actual values when ?resolve=true", async () => {
      collection = makeMockCollection([
        { _id: "abc", mcpName: "my-server", key: "GITHUB_TOKEN", createdAt: new Date(), updatedAt: new Date() },
      ]);
      store = makeMockStore(new Map([["mcp-envvar-abc", "ghp_real"]]));
      app = makeApp(collection, store);

      const res = await request(app, "GET", "/mcp/servers/my-server/env-vars?resolve=true");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ GITHUB_TOKEN: "ghp_real" });
    });

    it("returns empty array if no env vars exist", async () => {
      const res = await request(app, "GET", "/mcp/servers/empty-server/env-vars");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("DELETE /mcp/servers/:mcpName/env-vars/:id", () => {
    it("deletes KV secret and MongoDB document", async () => {
      collection = makeMockCollection([
        { _id: "abc", mcpName: "my-server", key: "GITHUB_TOKEN", createdAt: new Date(), updatedAt: new Date() },
      ]);
      store = makeMockStore(new Map([["mcp-envvar-abc", "ghp_real"]]));
      app = makeApp(collection, store);

      const res = await request(app, "DELETE", "/mcp/servers/my-server/env-vars/abc");

      expect(res.status).toBe(204);
      expect(store.deleteSecret).toHaveBeenCalledWith("mcp-envvar-abc");
      expect(collection.deleteOne).toHaveBeenCalledOnce();
    });

    it("returns 404 if env var not found", async () => {
      const res = await request(app, "DELETE", "/mcp/servers/my-server/env-vars/nonexistent");
      expect(res.status).toBe(404);
    });

    it("still deletes from MongoDB even if KV delete fails", async () => {
      collection = makeMockCollection([
        { _id: "abc", mcpName: "my-server", key: "KEY", createdAt: new Date(), updatedAt: new Date() },
      ]);
      store = makeMockStore();
      store.deleteSecret = vi.fn(async () => { throw Object.assign(new Error("KV error"), { statusCode: 500 }); });
      app = makeApp(collection, store);

      const res = await request(app, "DELETE", "/mcp/servers/my-server/env-vars/abc");

      expect(res.status).toBe(204);
      expect(collection.deleteOne).toHaveBeenCalledOnce();
    });
  });
});
