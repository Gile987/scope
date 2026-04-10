// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Router } from "express";
import { Collection, ObjectId } from "mongodb";
import type { McpEnvVarDocument } from "shared";
import { SecretStore } from "./keyvault-store.js";

/** KV secret name for an MCP env var — keyed by its MongoDB _id */
function envVarSecretName(id: string): string {
  return `mcp-envvar-${id}`;
}

export function createMcpEnvVarRouter(
  collection: Collection<McpEnvVarDocument>,
  store: SecretStore,
): Router {
  const router = Router();

  // ──────────────────────────────────────────────────────────────────────────
  // POST /mcp/servers/:mcpName/env-vars — store a new env var
  // ──────────────────────────────────────────────────────────────────────────
  router.post("/mcp/servers/:mcpName/env-vars", async (req, res, next) => {
    try {
      const { mcpName } = req.params;
      const { key, value } = req.body as { key?: string; value?: string };

      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "key is required" });
        return;
      }
      if (!value || typeof value !== "string") {
        res.status(400).json({ error: "value is required" });
        return;
      }

      const _id = new ObjectId();
      const secretName = envVarSecretName(_id.toHexString());

      await store.setSecret(secretName, value);

      const now = new Date();
      const doc: McpEnvVarDocument = {
        _id: _id.toHexString(),
        mcpName,
        key,
        createdAt: now,
        updatedAt: now,
      };
      await collection.insertOne(doc as any);

      res.status(201).json({ id: doc._id, mcpName: doc.mcpName, key: doc.key, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /mcp/servers/:mcpName/env-vars — list env var metadata (no values)
  // ?resolve=true — return actual key/value pairs (workers only)
  // ──────────────────────────────────────────────────────────────────────────
  router.get("/mcp/servers/:mcpName/env-vars", async (req, res, next) => {
    try {
      const { mcpName } = req.params;
      const shouldResolve = req.query.resolve === "true";

      const docs = await collection.find({ mcpName }).toArray();

      if (shouldResolve) {
        // Return { key: plaintext-value } map for workers
        const env: Record<string, string> = {};
        for (const doc of docs) {
          const secretName = envVarSecretName(doc._id);
          env[doc.key] = await store.getSecret(secretName);
        }
        res.json(env);
      } else {
        // Return metadata only — never expose values
        res.json(
          docs.map((d) => ({
            id: d._id,
            mcpName: d.mcpName,
            key: d.key,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
          })),
        );
      }
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /mcp/servers/:mcpName/env-vars/:id — delete one env var
  // ──────────────────────────────────────────────────────────────────────────
  router.delete("/mcp/servers/:mcpName/env-vars/:id", async (req, res, next) => {
    try {
      const { mcpName, id } = req.params;

      const doc = await collection.findOne({ _id: id as any, mcpName });
      if (!doc) {
        res.status(404).json({ error: "Env var not found" });
        return;
      }

      // Best-effort KV delete then remove from MongoDB
      try {
        await store.deleteSecret(envVarSecretName(id));
      } catch (err: any) {
        if (err?.statusCode !== 404) {
          console.warn(`[mcp-env-var-routes] KV delete failed for ${id}:`, err);
        }
      }

      await collection.deleteOne({ _id: id as any });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
