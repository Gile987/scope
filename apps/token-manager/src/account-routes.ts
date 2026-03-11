// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Router } from "express";
import { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import {
  AccountDocument,
  AccountType,
  AccountSecretValue,
  CreateAccountRequest,
  UpdateAccountRequest,
  deriveAccountSecretName,
} from "shared";
import { TokenSecretStore } from "./keyvault-store.js";

const VALID_ACCOUNT_TYPES: AccountType[] = ["github"];

export function createAccountRouter(
  collection: Collection<AccountDocument>,
  store: TokenSecretStore
): Router {
  const router = Router();

  // ──────────────────────────────────────────────
  // POST /api/v1/accounts — Register a new account
  // ──────────────────────────────────────────────
  router.post("/api/v1/accounts", async (req, res, next) => {
    try {
      const body = req.body as CreateAccountRequest;

      if (!body.type || !VALID_ACCOUNT_TYPES.includes(body.type)) {
        res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_ACCOUNT_TYPES.join(", ")}`,
        });
        return;
      }
      if (!body.username || typeof body.username !== "string") {
        res.status(400).json({ error: "username is required" });
        return;
      }
      if (!body.password || typeof body.password !== "string") {
        res.status(400).json({ error: "password is required" });
        return;
      }
      if (!body.totpSecret || typeof body.totpSecret !== "string") {
        res.status(400).json({ error: "totpSecret is required" });
        return;
      }

      const id = uuidv4();
      const secretName = deriveAccountSecretName(body.type, id);

      // Store secrets as a single JSON blob in KeyVault
      const secretValue: AccountSecretValue = {
        username: body.username,
        password: body.password,
        totpSecret: body.totpSecret,
      };
      await store.setSecret(secretName, JSON.stringify(secretValue));

      const doc: AccountDocument = {
        _id: id,
        type: body.type,
        secretName,
        enabled: body.enabled !== false,
        createdAt: new Date(),
      };

      if (typeof body.comment === "string" && body.comment.trim()) {
        doc.comment = body.comment.trim().substring(0, 500);
      }

      await collection.insertOne(doc as any);

      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/accounts — List all accounts (metadata)
  // ──────────────────────────────────────────────
  router.get("/api/v1/accounts", async (req, res, next) => {
    try {
      const accounts = await collection
        .find({ deletedAt: { $exists: false } })
        .toArray();
      accounts.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(accounts);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/accounts/:id — Get one account (metadata)
  // ──────────────────────────────────────────────
  router.get("/api/v1/accounts/:id", async (req, res, next) => {
    try {
      const account = await collection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });

      if (!account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      res.json(account);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/accounts/:id/secrets — Read secrets (internal only)
  // ──────────────────────────────────────────────
  router.get("/api/v1/accounts/:id/secrets", async (req, res, next) => {
    try {
      const account = await collection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });

      if (!account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const raw = await store.getSecret(account.secretName);
      const secrets: AccountSecretValue = JSON.parse(raw);

      res.json(secrets);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // PUT /api/v1/accounts/:id — Update metadata (and optionally secrets)
  // ──────────────────────────────────────────────
  router.put("/api/v1/accounts/:id", async (req, res, next) => {
    try {
      const body = req.body as UpdateAccountRequest;
      const update: Record<string, unknown> = { updatedAt: new Date() };

      if (typeof body.enabled === "boolean") {
        update.enabled = body.enabled;
      }

      if (body.comment !== undefined) {
        update.comment =
          typeof body.comment === "string" && body.comment.trim()
            ? body.comment.trim().substring(0, 500)
            : null;
      }

      // If any secret field is provided, rotate secrets in KeyVault
      if (body.username || body.password || body.totpSecret) {
        const account = await collection.findOne({
          _id: req.params.id,
          deletedAt: { $exists: false },
        });

        if (!account) {
          res.status(404).json({ error: "Account not found" });
          return;
        }

        // Read existing secrets, merge with provided values
        const raw = await store.getSecret(account.secretName);
        const existing: AccountSecretValue = JSON.parse(raw);
        const merged: AccountSecretValue = {
          username: body.username || existing.username,
          password: body.password || existing.password,
          totpSecret: body.totpSecret || existing.totpSecret,
        };
        await store.setSecret(account.secretName, JSON.stringify(merged));
      }

      const result = await collection.findOneAndUpdate(
        { _id: req.params.id, deletedAt: { $exists: false } },
        { $set: update },
        { returnDocument: "after" }
      );

      if (!result) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // DELETE /api/v1/accounts/:id — Soft-delete
  // ──────────────────────────────────────────────
  router.delete("/api/v1/accounts/:id", async (req, res, next) => {
    try {
      const result = await collection.findOneAndUpdate(
        { _id: req.params.id, deletedAt: { $exists: false } },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      if (!result) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      // KeyVault secret stays — soft-delete is reversible
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
