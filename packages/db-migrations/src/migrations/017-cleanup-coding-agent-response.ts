// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: bring legacy electron runs up to the post-#813 shape.
 *
 * Two distinct fixes, applied to both `requests` (current attempt at
 * `run.*`) and `runs` (history attempts at top level):
 *
 * 1. **Per-turn `codingAgentResponse`**
 *    - **Empty string** → `$unset`. The portal then renders its
 *      "no response captured" placeholder consistently with the new
 *      optional shape introduced in growth-ecosystems/scope-core#811.
 *    - **IChatAgentResult2 envelope** (the #808 root cause — the electron
 *      worker used to store `JSON.stringify(IChatAgentResult2)` here,
 *      hundreds of KB of `toolCallRounds`, `toolCallResults`,
 *      `renderedUserMessage`, …):
 *        a. Re-upload to `{requestId}/runs/{runId}/iteration-{n}/chat-result.json`
 *           in the `snapshots` container.
 *        b. `$set` `chatResultUrl` + `chatResultFormat = "IChatAgentResult2"`
 *           on the turn so callers can fetch the envelope on demand.
 *        c. Run the same `extractFinalResponse()` logic as the runtime
 *           fix (#813) on the parsed envelope and `$set`
 *           `codingAgentResponse` to the extracted text (capped at
 *           `MAX_RESPONSE_LENGTH`). If extraction yields nothing,
 *           `$unset` instead so the UI shows its "missing" placeholder.
 *      If the blob upload fails the envelope is preserved inline so the
 *      migration can be re-run later. If a runId/iteration cannot be
 *      derived (blob path unrecoverable) we still extract the text and
 *      `$set` / `$unset` accordingly — the giant inline JSON has to go.
 *
 * 2. **Top-level `result` field** (`requests.run.result`, `runs.result`)
 *    - **IChatAgentResult2 envelope** (same root cause: the runtime used
 *      to dump the full envelope into `result` too) → replace with the
 *      cleaned `codingAgentResponse` of the last touched turn (preserves
 *      the runtime invariant `run.result === codingAgentResponse of last
 *      passing turn`). If no turn was touched this pass (idempotent
 *      re-run, or turns were already clean), fall back to extracting
 *      from the result envelope independently. `$unset` if extraction
 *      yields nothing. No new blob upload — the per-iteration blob from
 *      step 1 is the canonical persistent copy.
 *    - Other strings are left alone (they're already well-formed prose,
 *      e.g. error messages or "Max iterations reached" sentinels).
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
 *
 * The `extractFinalResponse()` helper below is intentionally a pinned
 * copy of the runtime version at
 * `apps/workers/coder-vscode-electron-driver-ext/src/extract-final-response.ts`.
 * Migrations should not chase upstream behaviour changes — they need
 * to mean exactly what they meant the day they were written.
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

// ---------------------------------------------------------------------------
// extractFinalResponse — pinned copy of the runtime version. See header
// docstring for why we don't import it from the worker package.
// ---------------------------------------------------------------------------

/** Hard cap on the extracted text length. Mirrors the runtime constant. */
const MAX_RESPONSE_LENGTH = 8 * 1024;

function truncate(s: string): string {
  if (s.length <= MAX_RESPONSE_LENGTH) return s;
  const marker = `\n\n[truncated — original ${s.length} chars; full transcript in rawChatUrl]`;
  return s.slice(0, MAX_RESPONSE_LENGTH - marker.length) + marker;
}

/** Mirrors `apps/workers/coder-vscode-electron-driver-ext/src/extract-final-response.ts`. */
function extractFinalResponse(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") {
    return result.trim().length > 0 ? truncate(result) : undefined;
  }
  if (typeof result !== "object") return undefined;

  const obj = result as Record<string, unknown>;
  const metadata = obj.metadata as Record<string, unknown> | undefined;

  const toolCallRounds = metadata?.toolCallRounds;
  if (Array.isArray(toolCallRounds) && toolCallRounds.length > 0) {
    for (let i = toolCallRounds.length - 1; i >= 0; i--) {
      const r = toolCallRounds[i] as Record<string, unknown> | undefined;
      const response = r?.response;
      if (typeof response === "string" && response.trim().length > 0) {
        return truncate(response);
      }
    }
  }

  const summaries = metadata?.summaries;
  if (Array.isArray(summaries) && summaries.length > 0) {
    for (let i = summaries.length - 1; i >= 0; i--) {
      const s = summaries[i] as Record<string, unknown> | undefined;
      const text = s?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        return truncate(text);
      }
    }
  }
  return undefined;
}

/** Parse an envelope-shaped string and run extractFinalResponse on it.
 *  Returns undefined for unparseable strings or empty extractions. */
function extractFromEnvelopeString(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return extractFinalResponse(parsed);
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
  resultPath: string,
  uploader: EnvelopeUploader | null,
  label: string,
): Promise<{ docs: number; turnsCleaned: number; envelopesUploaded: number; envelopesSkipped: number; resultsCleaned: number }> {
  let docsModified = 0;
  let turnsCleaned = 0;
  let envelopesUploaded = 0;
  let envelopesSkipped = 0;
  let resultsCleaned = 0;
  let processed = 0;
  let batch: AnyBulkWriteOperation[] = [];

  // Match docs where either:
  //   - any turn carries a string-typed codingAgentResponse, or
  //   - the top-level result field is a string (we'll filter to
  //     envelope-shaped strings in code).
  // The runtime invariant (`run.result === codingAgentResponse of last
  // passing turn`) means most docs match both, but the union covers
  // already-half-cleaned docs from earlier migration runs too.
  const filter = {
    $or: [
      { [turnsPath]: { $elemMatch: { codingAgentResponse: { $type: "string" } } } },
      { [resultPath]: { $type: "string" } },
    ],
  };

  const projection: Record<string, 1> = { _id: 1, [turnsPath]: 1, [resultPath]: 1 };
  if (collection === "requests") projection["run._id"] = 1;
  if (collection === "runs") projection["requestId"] = 1;

  const cursor = col.find(filter, { projection, batchSize: 50 });

  for await (const doc of cursor) {
    const turns: any[] | undefined = turnsPath
      .split(".")
      .reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), doc);
    const ids = resolveIds(doc, collection);

    const unset: Record<string, ""> = {};
    const set: Record<string, string> = {};
    let perDocCount = 0;
    // Tracks the most recent extracted text we wrote to a turn during
    // this doc's pass. Used to keep the runtime invariant
    // `run.result === codingAgentResponse of last passing turn` intact:
    // when we rewrite the top-level result field below we copy this value
    // rather than re-extracting from the result envelope independently.
    let lastExtractedTurnText: string | undefined;

    if (Array.isArray(turns) && turns.length > 0) {
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const value = turn?.codingAgentResponse;

        if (isEmptyString(value)) {
          unset[`${turnsPath}.${i}.codingAgentResponse`] = "";
          perDocCount++;
          continue;
        }

        if (!isEnvelopeString(value)) continue;

        // Envelope: rescue to blob (if path derivable), then replace the
        // inline value with the extracted final response so the document
        // matches the post-#813 shape that new electron runs produce.
        // (`up()` guarantees `uploader` is non-null at this point.)
        const iteration = typeof turn?.iteration === "number" ? turn.iteration : null;
        const extracted = extractFromEnvelopeString(value);
        const fieldPath = `${turnsPath}.${i}.codingAgentResponse`;
        const applyExtractedText = () => {
          if (extracted) {
            set[fieldPath] = extracted;
            lastExtractedTurnText = extracted;
          } else {
            unset[fieldPath] = "";
            // A turn with an unparseable envelope counts as "last cleaned"
            // for the purpose of mirroring the runtime invariant on
            // run.result — even if the value is undefined.
            lastExtractedTurnText = undefined;
          }
        };

        if (uploader && ids && iteration !== null) {
          const blobName = `${ids.requestId}/runs/${ids.runId}/iteration-${iteration}/chat-result.json`;
          try {
            const url = await uploader.upload(blobName, value);
            set[`${turnsPath}.${i}.chatResultUrl`] = url;
            set[`${turnsPath}.${i}.chatResultFormat`] = "IChatAgentResult2";
            applyExtractedText();
            envelopesUploaded++;
            perDocCount++;
          } catch (err: any) {
            // Leave inline so a future re-run can retry. Don't $set/$unset.
            envelopesSkipped++;
            console.log(`  ${label}: envelope upload failed for ${blobName}, leaving inline: ${err?.message ?? err}`);
          }
        } else {
          // ids/iteration unrecoverable — the blob path can't be derived.
          // We still replace the inline envelope with the extracted text
          // (or $unset if extraction yielded nothing): the giant string keeps
          // blowing past the 2 MB document limit and prose is far better
          // than nothing for the portal.
          applyExtractedText();
          envelopesSkipped++;
          perDocCount++;
          console.log(`  ${label}: blob path unrecoverable for ${turnsPath}[${i}] (no runId/iteration), replacing inline envelope with extracted text only`);
        }
      }
    }

    // Top-level result field: same root cause (electron runtime used to
    // dump the full envelope here too). Mirror runtime semantics: when a
    // turn was just cleaned, copy its extracted text so the document
    // honours `run.result === turns[last_passing].codingAgentResponse`.
    // Otherwise (no turns touched this pass) extract independently from
    // the result envelope. Either way, no new blob upload — the
    // per-iteration blob is the canonical persistent copy.
    const resultValue = resultPath
      .split(".")
      .reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), doc);
    if (isEnvelopeString(resultValue)) {
      let resultText: string | undefined;
      if (perDocCount > 0) {
        // A turn was cleaned this pass — use its extracted text to keep
        // the runtime invariant intact. May be undefined if the last
        // cleaned turn's envelope yielded nothing.
        resultText = lastExtractedTurnText;
      } else {
        // Standalone broken result (idempotent re-run, or turns were
        // already clean). Fall back to extracting from the envelope.
        resultText = extractFromEnvelopeString(resultValue);
      }
      if (resultText) set[resultPath] = resultText;
      else unset[resultPath] = "";
      resultsCleaned++;
      perDocCount++;
    }

    if (perDocCount === 0) continue;

    const update: { $unset?: Record<string, "">; $set?: Record<string, unknown> } = {};
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
    `  ${label}: done — processed ${processed} docs, modified ${docsModified}, turns cleaned ${turnsCleaned}, envelopes uploaded ${envelopesUploaded}, envelopes skipped ${envelopesSkipped}, results cleaned ${resultsCleaned}`,
  );
  return { docs: docsModified, turnsCleaned, envelopesUploaded, envelopesSkipped, resultsCleaned };
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
      "run.result",
      uploader,
      "requests — codingAgentResponse + run.result cleanup",
    );
    await cleanupCollection(
      db.collection("runs"),
      "runs",
      "turns",
      "result",
      uploader,
      "runs — codingAgentResponse + result cleanup",
    );
  }

  async down(_db: Db): Promise<void> {
    // The original inline values were either bloated IChatAgentResult2
    // envelopes (now uploaded as blobs and reachable via chatResultUrl) or
    // empty strings — neither is worth (or possible) to write back inline.
    console.log("down: no-op — chat-result blobs persist; document-side fields cannot be restored");
  }
}
