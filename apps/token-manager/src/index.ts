// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, Collection, Db } from "mongodb";
import { TokenDocument } from "shared";
import { createTokenStore, TokenSecretStore } from "./keyvault-store.js";
import { createTokenRouter } from "./routes.js";
import { startTokenScheduler } from "./token-scheduler.js";
import { validateToken } from "./token-validators.js";

dotenv.config();

const port = parseInt(process.env.PORT || "3000", 10);
const mongoUri = process.env.MONGO_CONNECTION_STRING || "mongodb://localhost:27000";
const dbName = process.env.MONGO_DATABASE || "scoped";
const keyvaultUri = process.env.AZURE_KEYVAULT_URI;
const validationIntervalMs = parseInt(
  process.env.TOKEN_VALIDATION_INTERVAL_MS || "300000",
  10
);

let db: Db;
let tokensCollection: Collection<TokenDocument>;
let tokenStore: TokenSecretStore;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "token-manager" });
});

async function initializeClients(): Promise<void> {
  console.log("[token-manager] Connecting to MongoDB...");
  const client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db(dbName);
  tokensCollection = db.collection<TokenDocument>("tokens");

  // Create indexes
  try {
    await tokensCollection.createIndex(
      { usage: 1, enabled: 1, deletedAt: 1 },
    );
  } catch (err) {
    console.log("[token-manager] Index usage/enabled/deletedAt may already exist");
  }

  console.log("[token-manager] MongoDB connected, tokens collection ready");

  // Initialize secret store (Azure Key Vault in production, Lowkey Vault locally)
  if (!keyvaultUri) {
    throw new Error(
      "AZURE_KEYVAULT_URI is required. Set it to an Azure Key Vault URI " +
      "or use Docker Compose which provides Lowkey Vault automatically."
    );
  }
  tokenStore = createTokenStore(keyvaultUri);
  console.log(`[token-manager] Secret store: ${keyvaultUri}`);

  // Mount token routes
  const router = createTokenRouter(tokensCollection, tokenStore);
  app.use(router);

  // Start validation scheduler
  const scheduler = startTokenScheduler({
    collection: tokensCollection,
    getSecretValue: (name) => tokenStore.getSecret(name),
    validateToken,
    intervalMs: validationIntervalMs,
  });

  // Graceful shutdown
  const shutdownHandler = () => {
    console.log("[token-manager] Shutdown signal received, stopping scheduler...");
    scheduler.stop();
    client.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);
}

// Error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[token-manager] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

async function main(): Promise<void> {
  await initializeClients();
  app.listen(port, () => {
    console.log(`[token-manager] listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("[token-manager] Failed to start:", error);
  process.exit(1);
});
