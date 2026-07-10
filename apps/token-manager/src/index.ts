// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, Collection, Db } from "mongodb";
import { KeyDocument, AccountDocument, McpSecretDocument, McpServerDocument } from "shared";
import { createSecretStore, SecretStore } from "./keyvault-store.js";
import { createKeyRouter } from "./routes.js";
import { createAccountRouter } from "./account-routes.js";
import { createMcpSecretRouter } from "./mcp-secret-routes.js";
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
let keysCollection: Collection<KeyDocument>;
let accountsCollection: Collection<AccountDocument>;
let mcpSecretsCollection: Collection<McpSecretDocument>;
let mcpServerCollection: Collection<McpServerDocument>;
let secretStore: SecretStore;

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
  keysCollection = db.collection<KeyDocument>("tokens");
  accountsCollection = db.collection<AccountDocument>("accounts");
  mcpSecretsCollection = db.collection<McpSecretDocument>("mcp-secrets");
  mcpServerCollection = db.collection<McpServerDocument>("mcp-servers");

  // Create indexes
  try {
    await keysCollection.createIndex(
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
  secretStore = createSecretStore(keyvaultUri);
  console.log(`[token-manager] Secret store: ${keyvaultUri}`);

  // Mount key routes
  const router = createKeyRouter(keysCollection, secretStore);
  app.use(router);

  // Mount account routes
  const accountRouter = createAccountRouter(accountsCollection, secretStore);
  app.use(accountRouter);

  // Mount MCP secret routes
  // Backfill projectId on legacy secrets (from their server's projectId) BEFORE creating
  // the { projectId, mcpId, name } unique index, so pre-feature secrets are project-scoped.
  await backfillSecretProjectIds(mcpSecretsCollection, mcpServerCollection);

  // Drop the legacy pre-Projects unique index on { mcpId, name }. Before per-project
  // scoping, secret uniqueness was global per server slug; now that server slugs are
  // reused across projects, uniqueness moved to { projectId, mcpId, name } (created
  // below). If the old unique index survives, a second project reusing a (server slug,
  // secret name) pair — e.g. `github` + `GITHUB_TOKEN` — fails its insert with E11000
  // → 500, silently defeating per-project secret isolation. This drop runs at every
  // boot right before the composite index is (re)created, so ordering is guaranteed
  // (mcp-secrets indexes are managed here at startup, not via a migration). Tolerate
  // "index not found" (codes 26/27) so fresh DBs are a no-op. (On Cosmos the composite
  // unique index degrades to non-unique; the app-level scoped dup-check in
  // mcp-secret-routes still enforces per-project uniqueness.)
  try {
    await mcpSecretsCollection.dropIndex({ mcpId: 1, name: 1 } as any);
    console.log("[token-manager] Dropped legacy mcp-secrets { mcpId, name } unique index");
  } catch (err: any) {
    if (err?.code === 26 || err?.code === 27) {
      console.log("[token-manager] Legacy mcp-secrets { mcpId, name } index not present (skip drop)");
    } else {
      console.log(
        `[token-manager] Could not drop legacy mcp-secrets { mcpId, name } index: ${err?.message ?? err}`,
      );
    }
  }

  // Create unique index on { projectId, mcpId, name } to enforce no duplicate secret
  // names per server per project (server slugs are reused across projects).
  try {
    await mcpSecretsCollection.createIndex({ projectId: 1, mcpId: 1, name: 1 }, { unique: true });
  } catch (err) {
    console.log("[token-manager] Index mcp-secrets projectId/mcpId/name may already exist");
  }
  const mcpSecretRouter = createMcpSecretRouter(mcpSecretsCollection, mcpServerCollection, secretStore);
  app.use(mcpSecretRouter);

  // Start validation scheduler
  const scheduler = startTokenScheduler({
    collection: keysCollection,
    getSecretValue: (name) => secretStore.getSecret(name),
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

/**
 * One-off startup backfill: assign `projectId` to legacy MCP secrets that predate the
 * per-project scoping change. Each secret references its server by slug (`mcpId`), and every
 * server carries a `projectId` (migration 025), so we derive the secret's project from its
 * server. Server slugs were globally unique before the Projects feature, making the mapping
 * unambiguous. Idempotent: only touches docs missing `projectId`.
 */
async function backfillSecretProjectIds(
  secretsCollection: Collection<McpSecretDocument>,
  mcpServerCollection: Collection<McpServerDocument>,
): Promise<void> {
  const legacy = await secretsCollection.find({ projectId: { $exists: false } } as any).toArray();
  if (legacy.length === 0) return;

  console.log(`[token-manager] Backfilling projectId on ${legacy.length} legacy MCP secret(s)...`);
  let updated = 0;
  let orphaned = 0;
  const projectIdByMcpId = new Map<string, string | null>();

  for (const secret of legacy) {
    if (!projectIdByMcpId.has(secret.mcpId)) {
      // Resolve the server by its post-027 slug field, falling back to _id for pre-migration rows.
      const server = await mcpServerCollection.findOne({
        $or: [{ slug: secret.mcpId }, { _id: secret.mcpId }],
      });
      projectIdByMcpId.set(secret.mcpId, server?.projectId ?? null);
    }
    const projectId = projectIdByMcpId.get(secret.mcpId) ?? null;
    if (!projectId) {
      orphaned++;
      continue;
    }
    await secretsCollection.updateOne({ _id: secret._id as any }, { $set: { projectId } });
    updated++;
  }

  console.log(`[token-manager] Secret projectId backfill complete: ${updated} updated, ${orphaned} orphaned (no matching server).`);
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
