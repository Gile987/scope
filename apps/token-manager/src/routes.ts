// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Router } from "express";
import { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import {
  TokenDocument,
  TokenType,
  TokenUsage,
  AcquireTokenResponse,
  CreateTokenRequest,
  UpdateTokenRequest,
  AcquireTokenRequest,
  deriveSecretName,
} from "shared";
import { TokenSecretStore } from "./keyvault-store.js";
import { validateToken } from "./token-validators.js";
import { RoundRobinMap } from "./round-robin.js";

const VALID_TYPES: TokenType[] = [
  "github-pat",
  "anthropic-api-key",
  "github-models-api-key",
  "github-oauth-state",
];
const VALID_USAGES: TokenUsage[] = [
  "copilot",
  "claude-code",
  "github-models",
  "vscode-web",
];

export function createTokenRouter(
  collection: Collection<TokenDocument>,
  store: TokenSecretStore
): Router {
  const router = Router();
  const roundRobin = new RoundRobinMap<TokenDocument>();

  // ──────────────────────────────────────────────
  // POST /api/v1/tokens — Register a new token
  // ──────────────────────────────────────────────
  router.post("/api/v1/tokens", async (req, res, next) => {
    try {
      const body = req.body as CreateTokenRequest;

      // Validate required fields
      if (!body.type || !VALID_TYPES.includes(body.type)) {
        res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
        return;
      }
      if (!body.usage || !VALID_USAGES.includes(body.usage)) {
        res.status(400).json({
          error: `Invalid usage. Must be one of: ${VALID_USAGES.join(", ")}`,
        });
        return;
      }
      if (!body.value || typeof body.value !== "string") {
        res.status(400).json({ error: "value is required" });
        return;
      }

      const id = uuidv4();
      const secretName = deriveSecretName(body.usage, id);

      // Store secret value
      await store.setSecret(secretName, body.value);

      // Create metadata document
      const doc: TokenDocument = {
        _id: id,
        type: body.type,
        usage: body.usage,
        secretName,
        enabled: body.enabled !== false,
        lastValidationStatus: "unknown",
        createdAt: new Date(),
      };

      if (body.expiresAt) {
        doc.expiresAt = new Date(body.expiresAt);
      }

      await collection.insertOne(doc as any);

      // Run immediate validation (fire-and-forget)
      validateToken(body.type, body.value)
        .then(async (result) => {
          await collection.updateOne(
            { _id: id },
            {
              $set: {
                lastValidatedAt: new Date(),
                lastValidationStatus: result.status,
                lastValidationError: result.error || null,
                updatedAt: new Date(),
              },
            }
          );
        })
        .catch((err) => {
          console.error(
            `[routes] Background validation failed for ${id}:`,
            err
          );
        });

      // Return metadata (never the value)
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/tokens — List all tokens (metadata)
  // ──────────────────────────────────────────────
  router.get("/api/v1/tokens", async (req, res, next) => {
    try {
      const filter: Record<string, unknown> = {
        deletedAt: { $exists: false },
      };

      if (req.query.usage) {
        filter.usage = req.query.usage;
      }

      const tokens = await collection.find(filter).toArray();
      tokens.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/tokens/:id — Get one token (metadata)
  // ──────────────────────────────────────────────
  router.get("/api/v1/tokens/:id", async (req, res, next) => {
    try {
      const token = await collection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });

      if (!token) {
        res.status(404).json({ error: "Token not found" });
        return;
      }

      res.json(token);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // PUT /api/v1/tokens/:id — Update metadata only
  // ──────────────────────────────────────────────
  router.put("/api/v1/tokens/:id", async (req, res, next) => {
    try {
      const body = req.body as UpdateTokenRequest;
      const update: Record<string, unknown> = { updatedAt: new Date() };

      if (typeof body.enabled === "boolean") {
        update.enabled = body.enabled;
      }

      if (body.expiresAt !== undefined) {
        update.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      }

      const result = await collection.findOneAndUpdate(
        { _id: req.params.id, deletedAt: { $exists: false } },
        { $set: update },
        { returnDocument: "after" }
      );

      if (!result) {
        res.status(404).json({ error: "Token not found" });
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // DELETE /api/v1/tokens/:id — Soft-delete
  // ──────────────────────────────────────────────
  router.delete("/api/v1/tokens/:id", async (req, res, next) => {
    try {
      const result = await collection.findOneAndUpdate(
        { _id: req.params.id, deletedAt: { $exists: false } },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      if (!result) {
        res.status(404).json({ error: "Token not found" });
        return;
      }

      // KeyVault secret stays — soft-delete is reversible
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // POST /api/v1/tokens/:id/validate — On-demand validation
  // ──────────────────────────────────────────────
  router.post("/api/v1/tokens/:id/validate", async (req, res, next) => {
    try {
      const token = await collection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });

      if (!token) {
        res.status(404).json({ error: "Token not found" });
        return;
      }

      const value = await store.getSecret(token.secretName);
      const result = await validateToken(token.type, value);

      await collection.updateOne(
        { _id: token._id },
        {
          $set: {
            lastValidatedAt: new Date(),
            lastValidationStatus: result.status,
            lastValidationError: result.error || null,
            updatedAt: new Date(),
          },
        }
      );

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // POST /api/v1/tokens/acquire — Round-robin token acquisition (internal)
  // ──────────────────────────────────────────────
  router.post("/api/v1/tokens/acquire", async (req, res, next) => {
    try {
      const body = req.body as AcquireTokenRequest;

      if (!body.usage || !VALID_USAGES.includes(body.usage)) {
        res.status(400).json({
          error: `Invalid usage. Must be one of: ${VALID_USAGES.join(", ")}`,
        });
        return;
      }

      const tokens = await collection
        .find({
          usage: body.usage,
          enabled: true,
          lastValidationStatus: "valid",
          deletedAt: { $exists: false },
        })
        .toArray();

      if (tokens.length === 0) {
        res.status(404).json({
          error: `No valid tokens available for usage '${body.usage}'`,
        });
        return;
      }

      // Round-robin selection
      const selected = roundRobin.next(body.usage, tokens);

      // Read secret value
      const value = await store.getSecret(selected.secretName);

      const response: AcquireTokenResponse = {
        value,
        tokenId: selected._id,
        usage: selected.usage,
        expiresAt: selected.expiresAt,
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
