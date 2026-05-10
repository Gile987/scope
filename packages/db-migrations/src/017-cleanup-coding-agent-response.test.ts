// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

function makeObjectId(n: number | string) {
  return `id-${n}` as any;
}

/** Build a stub uploader that records calls and lets each test control the
 *  return / failure behaviour. */
function makeUploader(impl: (blobName: string, body: string) => Promise<string> = async (b) => `https://blobs/${b}`) {
  const upload = vi.fn(impl);
  return { upload, calls: () => upload.mock.calls };
}

/** Build a mock collection whose `find()` yields the given docs and whose
 *  `bulkWrite()` records the operations it received. */
function makeMockCollection(docs: any[]) {
  const bulkWrite = vi.fn().mockImplementation(async (ops: any[]) => ({
    modifiedCount: ops.length,
  }));
  const find = vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      for (const d of docs) yield d;
    },
  });
  return { find, bulkWrite };
}

function makeMockDb(requestsDocs: any[], runsDocs: any[]): Db {
  const reqCol = makeMockCollection(requestsDocs);
  const runsCol = makeMockCollection(runsDocs);
  return {
    collection: vi.fn((name: string) => (name === "requests" ? reqCol : runsCol)),
    _reqCol: reqCol,
    _runsCol: runsCol,
  } as any;
}

const ENVELOPE = JSON.stringify({
  timings: { totalElapsed: 1000 },
  details: "Claude Sonnet 4.6 • 1x",
  metadata: {
    toolCallRounds: [{ response: "wrap up", toolCalls: [] }],
    toolCallResults: { tc1: "y" },
    renderedUserMessage: ["z"],
  },
});

const { CleanupCodingAgentResponse } = await import("./migrations/017-cleanup-coding-agent-response.js");

describe("migration 017: CleanupCodingAgentResponse", () => {
  describe("up()", () => {
    it("unsets empty-string codingAgentResponse on requests.run.turns[i] (no upload)", async () => {
      const docs = [
        {
          _id: makeObjectId(1),
          run: { _id: makeObjectId(1), turns: [
            { iteration: 1, codingAgentResponse: "" },
            { iteration: 2, codingAgentResponse: "real response, leave alone" },
            { iteration: 3, codingAgentResponse: "" },
          ] },
        },
      ];
      const uploader = makeUploader();
      const db = makeMockDb(docs, []) as any;

      await new CleanupCodingAgentResponse(uploader).up(db);

      expect(uploader.upload).not.toHaveBeenCalled();
      const [ops] = db._reqCol.bulkWrite.mock.calls[0];
      expect(ops[0].updateOne.update).toEqual({
        $unset: {
          "run.turns.0.codingAgentResponse": "",
          "run.turns.2.codingAgentResponse": "",
        },
      });
    });

    it("uploads bloated IChatAgentResult2 envelope to a per-iteration blob and rewrites the turn", async () => {
      const docs = [
        {
          _id: makeObjectId("req-A"),
          run: { _id: makeObjectId("run-A"), turns: [
            { iteration: 4, codingAgentResponse: ENVELOPE },
          ] },
        },
      ];
      const uploader = makeUploader();
      const db = makeMockDb(docs, []) as any;

      await new CleanupCodingAgentResponse(uploader).up(db);

      expect(uploader.upload).toHaveBeenCalledTimes(1);
      const [blobName, body] = uploader.upload.mock.calls[0];
      expect(blobName).toBe("id-req-A/runs/id-run-A/iteration-4/chat-result.json");
      expect(body).toBe(ENVELOPE);

      const [ops] = db._reqCol.bulkWrite.mock.calls[0];
      expect(ops[0].updateOne.update).toEqual({
        $set: {
          "run.turns.0.chatResultUrl": "https://blobs/id-req-A/runs/id-run-A/iteration-4/chat-result.json",
          "run.turns.0.chatResultFormat": "IChatAgentResult2",
        },
        $unset: {
          "run.turns.0.codingAgentResponse": "",
        },
      });
    });

    it("falls back to requests._id when run._id is missing (legacy first-attempt shape)", async () => {
      const docs = [
        {
          _id: makeObjectId("legacy"),
          run: { turns: [{ iteration: 1, codingAgentResponse: ENVELOPE }] },
        },
      ];
      const uploader = makeUploader();
      const db = makeMockDb(docs, []) as any;

      await new CleanupCodingAgentResponse(uploader).up(db);

      expect(uploader.upload).toHaveBeenCalledWith(
        "id-legacy/runs/id-legacy/iteration-1/chat-result.json",
        ENVELOPE,
      );
    });

    it("preserves inline envelope when upload fails (so the next run can retry)", async () => {
      const docs = [
        {
          _id: makeObjectId(1),
          run: { _id: makeObjectId(1), turns: [
            { iteration: 1, codingAgentResponse: ENVELOPE },
          ] },
        },
      ];
      const uploader = makeUploader(async () => {
        throw new Error("transient azure error");
      });
      const db = makeMockDb(docs, []) as any;

      await new CleanupCodingAgentResponse(uploader).up(db);

      // Upload was attempted but failed → no bulkWrite for this turn.
      expect(uploader.upload).toHaveBeenCalledTimes(1);
      expect(db._reqCol.bulkWrite).not.toHaveBeenCalled();
    });

    it("drops inline envelope when no uploader is available (cleanup-only mode)", async () => {
      const docs = [
        {
          _id: makeObjectId(1),
          run: { _id: makeObjectId(1), turns: [
            { iteration: 1, codingAgentResponse: ENVELOPE },
          ] },
        },
      ];
      const db = makeMockDb(docs, []) as any;

      // No uploader injected and no env vars set in test → cleanup-only.
      const prev = { conn: process.env.AZURE_STORAGE_CONNECTION_STRING, account: process.env.AZURE_STORAGE_ACCOUNT_NAME };
      delete process.env.AZURE_STORAGE_CONNECTION_STRING;
      delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
      try {
        await new CleanupCodingAgentResponse().up(db);
      } finally {
        if (prev.conn) process.env.AZURE_STORAGE_CONNECTION_STRING = prev.conn;
        if (prev.account) process.env.AZURE_STORAGE_ACCOUNT_NAME = prev.account;
      }

      const [ops] = db._reqCol.bulkWrite.mock.calls[0];
      expect(ops[0].updateOne.update).toEqual({
        $unset: { "run.turns.0.codingAgentResponse": "" },
      });
    });

    it("leaves legitimate prose responses untouched", async () => {
      const docs = [
        {
          _id: makeObjectId(1),
          run: { _id: makeObjectId(1), turns: [
            { iteration: 1, codingAgentResponse: "All registrations are correct. The complete system is built." },
            { iteration: 2, codingAgentResponse: "Done." },
            { iteration: 3, codingAgentResponse: 'I added a comment about "toolCallRounds" in the helper.' },
          ] },
        },
      ];
      const uploader = makeUploader();
      const db = makeMockDb(docs, []) as any;

      await new CleanupCodingAgentResponse(uploader).up(db);

      expect(uploader.upload).not.toHaveBeenCalled();
      expect(db._reqCol.bulkWrite).not.toHaveBeenCalled();
    });

    it("cleans the runs history collection at top-level turns[i] path with requestId-derived blob path", async () => {
      const docs = [
        {
          _id: makeObjectId("run-X"),
          requestId: "req-X",
          turns: [
            { iteration: 1, codingAgentResponse: "" },
            { iteration: 2, codingAgentResponse: ENVELOPE },
          ],
        },
      ];
      const uploader = makeUploader();
      const db = makeMockDb([], docs) as any;

      await new CleanupCodingAgentResponse(uploader).up(db);

      expect(uploader.upload).toHaveBeenCalledWith(
        "req-X/runs/id-run-X/iteration-2/chat-result.json",
        ENVELOPE,
      );
      const [ops] = db._runsCol.bulkWrite.mock.calls[0];
      expect(ops[0].updateOne.update).toEqual({
        $set: {
          "turns.1.chatResultUrl": "https://blobs/req-X/runs/id-run-X/iteration-2/chat-result.json",
          "turns.1.chatResultFormat": "IChatAgentResult2",
        },
        $unset: {
          "turns.0.codingAgentResponse": "",
          "turns.1.codingAgentResponse": "",
        },
      });
    });

    it("is a no-op on already-clean documents (idempotency)", async () => {
      const uploader = makeUploader();
      const db = makeMockDb([], []) as any;
      await new CleanupCodingAgentResponse(uploader).up(db);
      expect(uploader.upload).not.toHaveBeenCalled();
      expect(db._reqCol.bulkWrite).not.toHaveBeenCalled();
      expect(db._runsCol.bulkWrite).not.toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("is a no-op (does not touch any collection)", async () => {
      const uploader = makeUploader();
      const db = makeMockDb([], []) as any;
      await new CleanupCodingAgentResponse(uploader).down(db);
      expect(uploader.upload).not.toHaveBeenCalled();
      expect(db._reqCol.bulkWrite).not.toHaveBeenCalled();
      expect(db._runsCol.bulkWrite).not.toHaveBeenCalled();
    });
  });
});
