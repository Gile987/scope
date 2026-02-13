// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Criteria Syncer — Sidecar process that polls MongoDB for criteria
 * and writes them as YAML files to a shared volume.
 *
 * The judge container watches this directory via CriteriaRegistry.watch()
 * and reloads criteria on any file change.
 */
import { MongoClient, Collection } from 'mongodb';
import { writeFileSync, readdirSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { stringify as yamlStringify } from 'yaml';

const mongoUri = process.env.MONGO_CONNECTION_STRING || '';
const mongoDatabase = process.env.MONGO_DATABASE || 'requests-db';
const outputDir = process.env.OUTPUT_DIR || '/app/config/criteria';
const syncIntervalMs = parseInt(process.env.SYNC_INTERVAL_MS || '10000', 10);

interface CriteriaDocument {
  id: string;
  prompt: string;
  dependsOn?: string[];
  deletedAt?: Date;
}

async function sync(collection: Collection<CriteriaDocument>): Promise<void> {
  const criteria = await collection
    .find({ deletedAt: { $exists: false } })
    .toArray();

  // Ensure output dir exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Write/update YAML files
  const currentIds = new Set<string>();
  for (const c of criteria) {
    currentIds.add(c.id);
    const filename = `${c.id}.yaml`;
    const filePath = join(outputDir, filename);
    // Use depends_on for YAML compat with CriteriaRegistry loader
    const yamlContent = yamlStringify({
      id: c.id,
      prompt: c.prompt,
      ...(c.dependsOn && c.dependsOn.length > 0 ? { depends_on: c.dependsOn } : {}),
    });
    // Only write if content changed
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (existing === yamlContent) continue;
    }
    writeFileSync(filePath, yamlContent, 'utf-8');
    console.log(`[criteria-syncer] Updated ${filename}`);
  }

  // Remove files for deleted/absent criteria
  const existingFiles = readdirSync(outputDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  for (const file of existingFiles) {
    const fileId = file.replace(/\.(yaml|yml)$/, '');
    if (!currentIds.has(fileId)) {
      unlinkSync(join(outputDir, file));
      console.log(`[criteria-syncer] Removed ${file}`);
    }
  }
}

async function main(): Promise<void> {
  if (!mongoUri) {
    console.error('[criteria-syncer] MONGO_CONNECTION_STRING is required');
    process.exit(1);
  }

  console.log(`[criteria-syncer] Starting... (interval=${syncIntervalMs}ms, output=${outputDir})`);
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDatabase);
  const collection = db.collection<CriteriaDocument>('criteria');
  console.log(`[criteria-syncer] Connected to MongoDB`);

  // Initial sync
  await sync(collection);
  console.log(`[criteria-syncer] Initial sync complete`);

  // Periodic sync
  setInterval(async () => {
    try {
      await sync(collection);
    } catch (error) {
      console.error('[criteria-syncer] Sync error:', error);
    }
  }, syncIntervalMs);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[criteria-syncer] Shutting down...');
    await client.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[criteria-syncer] Failed to start:', error);
  process.exit(1);
});
