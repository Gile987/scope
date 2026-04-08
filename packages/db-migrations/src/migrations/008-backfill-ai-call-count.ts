// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill aiCallCount on existing turns and run documents.
 *
 * For runs that have turns with HAR files in blob storage but no aiCallCount,
 * this migration downloads each turn's HAR, counts the AI completion calls
 * (POST requests to /chat/completions or /v1/messages), and patches:
 *   - turns[i].aiCallCount — per-iteration LLM call count
 *   - request.aiCallCount  — sum of all turn counts for the run
 *
 * Runs that already have every turn's aiCallCount set are skipped.
 */

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { sleep, getRetryAfterMs, INTER_BATCH_DELAY_MS } from "../batch-update.js";

// Matches the same patterns as extractAiCallCount in har-parser.ts
const AI_COMPLETION_URL_PATTERNS: ReadonlyArray<RegExp> = [
  /\/chat\/completions$/,
  /\/v1\/messages$/,
];

function extractAiCallCountFromHar(har: { log: { entries: Array<{ request: { url: string } }> } }): number {
  return har.log.entries.filter((entry) =>
    AI_COMPLETION_URL_PATTERNS.some((p) => p.test(entry.request.url)),
  ).length;
}

function parseBlobNameFromUrl(harUrl: string): { blobName: string } {
  const CONTAINER = "snapshots";
  const url = new URL(harUrl);
  const containerPrefix = `/${CONTAINER}/`;
  const containerIndex = url.pathname.indexOf(containerPrefix);
  if (containerIndex === -1) {
    throw new Error(`HAR URL does not contain container '${CONTAINER}': ${harUrl}`);
  }
  const blobName = url.pathname.substring(containerIndex + containerPrefix.length);
  return { blobName };
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
      "Set STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME to enable HAR downloads",
    );
  }
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

async function downloadHarAsJson(
  containerClient: ReturnType<BlobServiceClient["getContainerClient"]>,
  blobName: string,
): Promise<{ log: { entries: Array<{ request: { url: string } }> } }> {
  const blobClient = containerClient.getBlobClient(blobName);
  const download = await blobClient.download();
  const chunks: Buffer[] = [];
  for await (const chunk of download.readableStreamBody as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class BackfillAiCallCount implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Target runs that have at least one turn with a harUrl but no aiCallCount
    const cursor = col.find({
      "turns.0": { $exists: true },
      "turns": {
        $elemMatch: {
          harUrl: { $exists: true },
          aiCallCount: { $exists: false },
        },
      },
    });

    let blobClient: ReturnType<BlobServiceClient["getContainerClient"]> | null = null;
    try {
      blobClient = createBlobServiceClient().getContainerClient("snapshots");
    } catch (err) {
      console.warn(
        `  WARNING: Could not create blob client — ${(err as Error).message}. Skipping migration.`,
      );
      return;
    }

    let updatedRuns = 0;
    let skippedRuns = 0;
    let updatedTurns = 0;
    let processedRuns = 0;

    for await (const doc of cursor) {
      processedRuns++;
      // Pace reads to avoid saturating CosmosDB RUs between documents
      if (processedRuns > 1) {
        await sleep(INTER_BATCH_DELAY_MS);
      }
      const turns: any[] = doc.turns ?? [];
      const updates: Record<string, any> = {};
      let hasUpdate = false;

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        if (!turn.harUrl || turn.aiCallCount !== undefined) {
          continue; // already patched or no HAR
        }

        try {
          const { blobName } = parseBlobNameFromUrl(turn.harUrl);
          const har = await downloadHarAsJson(blobClient, blobName);
          const count = extractAiCallCountFromHar(har);
          updates[`turns.${i}.aiCallCount`] = count;
          turns[i] = { ...turn, aiCallCount: count }; // keep local copy in sync for sum
          hasUpdate = true;
          updatedTurns++;
        } catch (err) {
          const msg = (err as Error).message;
          console.warn(`  Could not process HAR for run ${doc._id} turn ${i}: ${msg}`);
        }
      }

      if (hasUpdate) {
        // Recompute the run-level total from all turns (including previously set ones)
        const totalAiCallCount = turns.reduce(
          (sum: number, t: any) => sum + (t.aiCallCount ?? 0),
          0,
        );
        updates["aiCallCount"] = totalAiCallCount;

        // Pace writes to avoid saturating CosmosDB RUs; retry on 429
        await sleep(INTER_BATCH_DELAY_MS);
        let retries = 0;
        const maxRetries = 10;
        while (retries < maxRetries) {
          try {
            await col.updateOne({ _id: doc._id }, { $set: updates });
            break;
          } catch (err: any) {
            if (err?.code === 16500 && retries < maxRetries - 1) {
              const delay = Math.max(getRetryAfterMs(err), 500);
              console.log(`  429 on run ${doc._id}, retry ${retries + 1}/${maxRetries - 1}, waiting ${delay}ms...`);
              await sleep(delay);
              retries++;
            } else {
              throw err;
            }
          }
        }
        updatedRuns++;
      } else {
        skippedRuns++;
      }
    }

    console.log(
      `  Backfilled aiCallCount: ${updatedRuns} runs updated (${updatedTurns} turns), ${skippedRuns} skipped`,
    );
  }

  async down(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Remove only the backfilled fields — leave any that were set by live traffic
    // (since we cannot distinguish them, we remove all to be safe and rely on
    //  live runs to repopulate going forward)
    await col.updateMany(
      { aiCallCount: { $exists: true } },
      { $unset: { aiCallCount: "" } },
    );
    await col.updateMany(
      { "turns.aiCallCount": { $exists: true } },
      { $unset: { "turns.$[].aiCallCount": "" } },
    );

    console.log("  Removed backfilled aiCallCount from runs and turns");
  }
}
