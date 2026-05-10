// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill per-iteration tool-calls JSONL blobs.
 *
 * For documents (in both `requests` and `runs` collections) that still carry
 * an inline `run.turns[].toolCalls` array, this migration:
 *
 *   1. Writes the array to an Azure Append Blob at
 *      `{requestId}/runs/{runId}/iteration-{n}/tool-calls.jsonl`
 *      in the `snapshots` container (one ToolCall per JSONL line).
 *   2. Sets `run.turns[i].toolCallsUrl` to the blob URL and
 *      `run.turns[i].toolCallCount` to the array length.
 *   3. Unsets the inline `run.turns[i].toolCalls` array.
 *
 * Refs #812.
 *
 * Down() is best-effort: it unsets the new fields on every turn but cannot
 * reconstruct the inline arrays — the JSONL blobs remain in storage as the
 * canonical record. Restoring the previous shape would require a separate
 * read-from-blob step.
 */

import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { sleep, getRetryAfterMs, INTER_BATCH_DELAY_MS } from "../batch-update.js";

const SNAPSHOTS_CONTAINER = "snapshots";

interface InlineToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  response?: string;
  timestamp?: string;
}

interface MigratableTurn {
  iteration: number;
  toolCalls?: InlineToolCall[];
  toolCallsUrl?: string;
  toolCallCount?: number;
}

interface MigratableDoc {
  _id: string;
  /** Per-attempt run state — turns live under `run.turns` after migration 014. */
  run?: { _id?: string; turns?: MigratableTurn[] };
}

function createBlobServiceClient(): BlobServiceClient {
  const connectionString =
    process.env.STORAGE_CONNECTION_STRING ??
    process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString);
  }
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  if (!accountName) {
    throw new Error(
      "Set STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME to enable blob writes",
    );
  }
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

async function writeJsonlBlob(
  containerClient: ContainerClient,
  blobName: string,
  toolCalls: InlineToolCall[],
): Promise<string> {
  const appendBlobClient = containerClient.getAppendBlobClient(blobName);
  // createIfNotExists is idempotent — safe to re-run if a previous attempt
  // crashed mid-migration. We do not reset the blob: if it already has
  // content, the migration treats it as already written and skips append
  // (see callers).
  await appendBlobClient.createIfNotExists();

  // If the blob already has content (partial-replay or duplicate run), skip.
  const props = await appendBlobClient.getProperties();
  if ((props.contentLength ?? 0) > 0) {
    return appendBlobClient.url;
  }

  for (const tc of toolCalls) {
    const line = JSON.stringify(tc) + "\n";
    await appendBlobClient.appendBlock(line, Buffer.byteLength(line));
  }
  return appendBlobClient.url;
}

async function migrateCollection(
  db: Db,
  collectionName: "requests" | "runs",
  containerClient: ContainerClient,
): Promise<{ updatedDocs: number; updatedTurns: number; skippedDocs: number }> {
  const col = db.collection<MigratableDoc>(collectionName);

  // Match docs that still have at least one turn carrying an inline toolCalls array.
  const cursor = col.find(
    { "run.turns.toolCalls": { $exists: true } },
    { projection: { _id: 1, run: 1 } },
  );

  let updatedDocs = 0;
  let updatedTurns = 0;
  let skippedDocs = 0;
  let processedDocs = 0;

  for await (const doc of cursor) {
    processedDocs++;
    if (processedDocs > 1) {
      // Pace reads to avoid saturating CosmosDB RUs between documents
      await sleep(INTER_BATCH_DELAY_MS);
    }

    // Use the run's _id when present (preserves the per-attempt blob path
    // established by multi-turn-loop). Falls back to the document _id for
    // pre-014 documents that never got a separate run id.
    const runId = doc.run?._id ?? doc._id;
    const turns: MigratableTurn[] = doc.run?.turns ?? [];

    const setOps: Record<string, unknown> = {};
    const unsetOps: Record<string, ""> = {};
    let hasUpdate = false;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn.toolCalls || turn.toolCalls.length === 0) continue;

      try {
        const blobName = `${doc._id}/runs/${runId}/iteration-${turn.iteration}/tool-calls.jsonl`;
        const url = await writeJsonlBlob(containerClient, blobName, turn.toolCalls);
        setOps[`run.turns.${i}.toolCallsUrl`] = url;
        setOps[`run.turns.${i}.toolCallCount`] = turn.toolCalls.length;
        unsetOps[`run.turns.${i}.toolCalls`] = "";
        hasUpdate = true;
        updatedTurns++;
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(
          `  Could not write JSONL for ${collectionName} ${doc._id} turn ${i}: ${msg}`,
        );
      }
    }

    if (!hasUpdate) {
      skippedDocs++;
      continue;
    }

    // Pace writes; retry on CosmosDB 429
    await sleep(INTER_BATCH_DELAY_MS);
    let retries = 0;
    const maxRetries = 10;
    while (retries < maxRetries) {
      try {
        await col.updateOne(
          { _id: doc._id },
          { $set: setOps, $unset: unsetOps },
        );
        break;
      } catch (err: any) {
        if (err?.code === 16500 && retries < maxRetries - 1) {
          const delay = Math.max(getRetryAfterMs(err), 500);
          console.log(
            `  429 on ${collectionName} ${doc._id}, retry ${retries + 1}/${maxRetries - 1}, waiting ${delay}ms...`,
          );
          await sleep(delay);
          retries++;
        } else {
          throw err;
        }
      }
    }
    updatedDocs++;
  }

  return { updatedDocs, updatedTurns, skippedDocs };
}

export class BackfillToolCallsJsonl implements MigrationInterface {
  async up(db: Db): Promise<void> {
    let containerClient: ContainerClient;
    try {
      containerClient = createBlobServiceClient().getContainerClient(
        SNAPSHOTS_CONTAINER,
      );
      await containerClient.createIfNotExists();
    } catch (err) {
      console.warn(
        `  WARNING: Could not create blob client — ${(err as Error).message}. Skipping migration.`,
      );
      return;
    }

    for (const collectionName of ["requests", "runs"] as const) {
      console.log(`  Migrating ${collectionName}...`);
      const { updatedDocs, updatedTurns, skippedDocs } = await migrateCollection(
        db,
        collectionName,
        containerClient,
      );
      console.log(
        `  Backfilled tool-calls JSONL in ${collectionName}: ${updatedDocs} docs (${updatedTurns} turns), ${skippedDocs} skipped`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    // Unset the new fields on every turn. The JSONL blobs are left in place
    // (they are now the canonical record); restoring the previous inline
    // shape would require reading them back, which is out of scope for a
    // best-effort down() migration.
    for (const collectionName of ["requests", "runs"] as const) {
      const col = db.collection(collectionName);
      await col.updateMany(
        { "run.turns.toolCallsUrl": { $exists: true } },
        {
          $unset: {
            "run.turns.$[].toolCallsUrl": "",
            "run.turns.$[].toolCallCount": "",
          },
        },
      );
    }
    console.log("  Removed toolCallsUrl + toolCallCount from runs and requests");
  }
}
