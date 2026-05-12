// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: clean up `codingAgentResponse` on existing turns and rescue any
 * inline IChatAgentResult2 envelope to a per-iteration blob.
 *
 * Two cases on `requests.run.turns[i].codingAgentResponse` and
 * `runs.turns[i].codingAgentResponse`:
 *
 *   1. **Empty string** → `$unset` the field. The portal then renders its
 *      "no response captured" placeholder consistently with the new
 *      optional shape introduced in growth-ecosystems/scope-core#811.
 *
 *   2. **Bloated IChatAgentResult2 envelope** (the #808 root cause: turns
 *      produced before #811 by the electron worker stored
 *      `JSON.stringify(IChatAgentResult2)` here — typically hundreds of KB
 *      of `toolCallRounds`, `toolCallResults`, `renderedUserMessage`, …):
 *        a. Re-upload to
 *           `{requestId}/runs/{runId}/iteration-{n}/chat-result.json` in
 *           the `snapshots` container.
 *        b. `$set` `chatResultUrl` + `chatResultFormat = "IChatAgentResult2"`
 *           on the turn so callers can fetch the envelope on demand.
 *        c. `$unset` `codingAgentResponse`.
 *      If the upload fails the envelope is preserved inline so the
 *      migration can be re-run later. If a runId/iteration cannot be
 *      derived (truly unrecoverable blob path) the inline value is
 *      dropped — at that point it is already lost for joins and the
 *      giant string keeps blowing past the 2 MB document limit.
 *
 * The migration **fails fast** if no blob uploader can be built from
 * env (`STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONNECTION_STRING`,
 * or `AZURE_STORAGE_ACCOUNT_NAME` + managed identity) — running it
 * uploader-less would silently destroy data.
 *
 * Idempotent: legitimate prose responses are never matched (the matchers
 * require the value to look like a JSON object, not just mention the key
 * names). Re-running on cleaned documents is a no-op. Re-uploading a
 * blob that already exists overwrites with the same content.
 *
 * `down()` cannot reconstruct inline values — the blobs persist but the
 * document-side field rewrite is one-way.
 */

import type { Db, Collection, AnyBulkWriteOperation } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

const COSMOS_429 = 16500;
const BATCH_SIZE = 25;
const INTER_BATCH_DELAY_MS = 100;
const MAX_RETRIES = 5;
const DEFAULT_RETRY_MS = 50;
const SNAPSHOTS_CONTAINER = "snapshots";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottleError(err: any): boolean {
  return err?.code === COSMOS_429 || err?.message?.includes("TooManyRequests");
}

function getRetryAfterMs(err: any): number {
  return err?.errorResponse?.RetryAfterMs ?? err?.retryAfterMs ?? DEFAULT_RETRY_MS;
}

/** Empty-string `codingAgentResponse` left over from the intermediate fix. */
function isEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length === 0;
}

/** Returns true if `value` looks like a serialized IChatAgentResult2 envelope.
 *  Conservative — only matches values that are clearly junk. Prose responses
 *  that happen to mention the key names are never matched. */
function isEnvelopeString(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.startsWith("{")) return false;
  return (
    value.includes('"toolCallRounds"') ||
    value.includes('"toolCallResults"') ||
    value.includes('"renderedUserMessage"') ||
    /^\{"timings":/.test(value)
  );
}

/** Minimal blob upload abstraction so tests can inject a stub. */
export interface EnvelopeUploader {
  /** Upload `body` (a JSON string) to `blobName`. Returns the blob URL.
   *  Implementations must overwrite if the blob already exists so re-running
   *  the migration is idempotent. */
  upload(blobName: string, body: string): Promise<string>;
}

class AzureEnvelopeUploader implements EnvelopeUploader {
  private containerReady?: Promise<void>;

  constructor(private container: ContainerClient) {}

  async upload(blobName: string, body: string): Promise<string> {
    this.containerReady ??= this.container.createIfNotExists().then(() => undefined);
    await this.containerReady;
    const client = this.container.getBlockBlobClient(blobName);
    const buf = Buffer.from(body, "utf-8");
    await client.uploadData(buf, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
    return client.url;
  }
}

/** Build an EnvelopeUploader from environment variables. Returns `null` if
 *  blob storage is not configured — the migration then falls back to
 *  cleanup-only.
 *
 *  Env precedence matches the API (`apps/api/src/index.ts`):
 *    1. STORAGE_CONNECTION_STRING (the convention used by docker-compose
 *       and K8s secrets across the rest of the platform)
 *    2. AZURE_STORAGE_CONNECTION_STRING (alternate naming)
 *    3. AZURE_STORAGE_ACCOUNT_NAME + DefaultAzureCredential (managed
 *       identity in production). */
function buildUploaderFromEnv(): EnvelopeUploader | null {
  const conn =
    process.env.STORAGE_CONNECTION_STRING ||
    process.env.AZURE_STORAGE_CONNECTION_STRING;
  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  let client: BlobServiceClient;
  if (conn) {
    client = BlobServiceClient.fromConnectionString(conn);
  } else if (account) {
    client = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
  } else {
    return null;
  }
  return new AzureEnvelopeUploader(client.getContainerClient(SNAPSHOTS_CONTAINER));
}

async function executeBulkWithRetry(
  col: Collection,
  ops: AnyBulkWriteOperation[],
  label: string,
): Promise<number> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await col.bulkWrite(ops, { ordered: false });
      return res.modifiedCount;
    } catch (err: any) {
      if (isThrottleError(err) && attempt < MAX_RETRIES) {
        const retryMs = getRetryAfterMs(err);
        console.log(`  ${label}: 429 throttled, retrying in ${retryMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(retryMs);
        continue;
      }
      throw err;
    }
  }
  return 0;
}

/** Resolve `requestId` and `runId` for blob path construction.
 *  - `requests`: requestId = doc._id, runId = doc.run?._id ?? doc._id
 *    (the first attempt's run._id was historically the request's _id).
 *  - `runs`: requestId = doc.requestId, runId = doc._id. */
function resolveIds(
  doc: any,
  collection: "requests" | "runs",
): { requestId: string; runId: string } | null {
  if (collection === "requests") {
    const requestId = doc?._id;
    const runId = doc?.run?._id ?? doc?._id;
    if (!requestId || !runId) return null;
    return { requestId: String(requestId), runId: String(runId) };
  }
  const requestId = doc?.requestId;
  const runId = doc?._id;
  if (!requestId || !runId) return null;
  return { requestId: String(requestId), runId: String(runId) };
}

async function cleanupCollection(
  col: Collection,
  collection: "requests" | "runs",
  turnsPath: string,
  uploader: EnvelopeUploader | null,
  label: string,
): Promise<{ docs: number; turnsCleaned: number; envelopesUploaded: number; envelopesSkipped: number }> {
  let docsModified = 0;
  let turnsCleaned = 0;
  let envelopesUploaded = 0;
  let envelopesSkipped = 0;
  let processed = 0;
  let batch: AnyBulkWriteOperation[] = [];

  // Only consider documents with at least one string-typed codingAgentResponse.
  const filter = {
    [turnsPath]: {
      $elemMatch: { codingAgentResponse: { $type: "string" } },
    },
  };

  const projection: Record<string, 1> = { _id: 1, [turnsPath]: 1 };
  if (collection === "requests") projection["run._id"] = 1;
  if (collection === "runs") projection["requestId"] = 1;

  const cursor = col.find(filter, { projection, batchSize: 50 });

  for await (const doc of cursor) {
    const turns: any[] | undefined = turnsPath
      .split(".")
      .reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), doc);
    if (!Array.isArray(turns) || turns.length === 0) continue;

    const ids = resolveIds(doc, collection);

    const unset: Record<string, ""> = {};
    const set: Record<string, string> = {};
    let perDocCount = 0;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const value = turn?.codingAgentResponse;

      if (isEmptyString(value)) {
        unset[`${turnsPath}.${i}.codingAgentResponse`] = "";
        perDocCount++;
        continue;
      }

      if (!isEnvelopeString(value)) continue;

      // Envelope: try to rescue to blob, then $set + $unset.
      // (`up()` guarantees `uploader` is non-null at this point.)
      const iteration = typeof turn?.iteration === "number" ? turn.iteration : null;
      if (uploader && ids && iteration !== null) {
        const blobName = `${ids.requestId}/runs/${ids.runId}/iteration-${iteration}/chat-result.json`;
        try {
          const url = await uploader.upload(blobName, value);
          set[`${turnsPath}.${i}.chatResultUrl`] = url;
          set[`${turnsPath}.${i}.chatResultFormat`] = "IChatAgentResult2";
          unset[`${turnsPath}.${i}.codingAgentResponse`] = "";
          envelopesUploaded++;
          perDocCount++;
        } catch (err: any) {
          // Leave inline so a future re-run can retry. Don't $unset.
          envelopesSkipped++;
          console.log(`  ${label}: envelope upload failed for ${blobName}, leaving inline: ${err?.message ?? err}`);
        }
      } else {
        // ids/iteration unrecoverable — the blob path can't be derived.
        // Drop the inline value: it's already lost as far as joins go,
        // and the giant string keeps blowing past the 2 MB document limit.
        unset[`${turnsPath}.${i}.codingAgentResponse`] = "";
        envelopesSkipped++;
        perDocCount++;
        console.log(`  ${label}: dropping inline envelope at ${turnsPath}[${i}] — no runId/iteration available, blob path unrecoverable`);
      }
    }

    if (perDocCount === 0) continue;

    const update: { $unset?: Record<string, "">; $set?: Record<string, string> } = {};
    if (Object.keys(unset).length > 0) update.$unset = unset;
    if (Object.keys(set).length > 0) update.$set = set;

    batch.push({ updateOne: { filter: { _id: doc._id }, update } });
    turnsCleaned += perDocCount;

    if (batch.length >= BATCH_SIZE) {
      docsModified += await executeBulkWithRetry(col, batch, label);
      processed += batch.length;
      batch = [];
      if (processed % 100 === 0) {
        console.log(`  ${label}: processed ${processed} docs, modified ${docsModified}, turns cleaned ${turnsCleaned}, envelopes uploaded ${envelopesUploaded}`);
      }
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  if (batch.length > 0) {
    docsModified += await executeBulkWithRetry(col, batch, label);
    processed += batch.length;
  }

  console.log(
    `  ${label}: done — processed ${processed} docs, modified ${docsModified}, turns cleaned ${turnsCleaned}, envelopes uploaded ${envelopesUploaded}, envelopes skipped ${envelopesSkipped}`,
  );
  return { docs: docsModified, turnsCleaned, envelopesUploaded, envelopesSkipped };
}

export class CleanupCodingAgentResponse implements MigrationInterface {
  /** Optional uploader injection point for tests. When not provided,
   *  `up()` builds one from environment variables. */
  constructor(private uploader?: EnvelopeUploader) {}

  async up(db: Db): Promise<void> {
    const uploader = this.uploader ?? buildUploaderFromEnv();
    if (!uploader) {
      throw new Error(
        "migration 017: no blob uploader configured \u2014 set STORAGE_CONNECTION_STRING, AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT_NAME so inline IChatAgentResult2 envelopes can be rescued to blob storage. Without one, this migration would silently lose data.",
      );
    }
    await cleanupCollection(
      db.collection("requests"),
      "requests",
      "run.turns",
      uploader,
      "requests — codingAgentResponse cleanup",
    );
    await cleanupCollection(
      db.collection("runs"),
      "runs",
      "turns",
      uploader,
      "runs — codingAgentResponse cleanup",
    );
  }

  async down(_db: Db): Promise<void> {
    // The original inline values were either bloated IChatAgentResult2
    // envelopes (now uploaded as blobs and reachable via chatResultUrl) or
    // empty strings — neither is worth (or possible) to write back inline.
    console.log("down: no-op — chat-result blobs persist; document-side fields cannot be restored");
  }
}
