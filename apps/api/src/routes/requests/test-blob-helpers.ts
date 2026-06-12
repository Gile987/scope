// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared test utilities for blob-proxied artifact endpoint tests.
 *
 * Each test file must declare its own vi.mock() calls (Vitest hoists them per-module),
 * but can reuse these helpers for URL building, mock wiring, and stream simulation.
 */
import { Readable } from "stream";
import { vi } from "vitest";

// ─── Stream & response helpers ─────────────────────────────────────────────

/** Create a Readable stream from a string (simulates blob download body). */
export function readableFrom(content: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(content)]);
}

/** Raw supertest response parser — avoids JSON parsing for binary/stream responses. */
export function rawParser(res: any, cb: (err: Error | null, body: string) => void): void {
  let data = "";
  res.on("data", (chunk: Buffer) => (data += chunk.toString()));
  res.on("end", () => cb(null, data));
}

/** Standard blob URL in the format the endpoints expect. */
export function blobUrl(path: string): string {
  return `https://mockaccount.blob.core.windows.net/snapshots/${path}`;
}

// ─── Path variant helpers ──────────────────────────────────────────────────

export type PathVariant = {
  label: string;
  /** Build the URL for a given request id — append the artifact path after this */
  url: (id: string) => string;
  /** Mock findOne to return a request with the given run */
  mockRequest: (mocks: any, id: string, run: Record<string, unknown>) => void;
};

export const REQUEST_LEVEL: PathVariant = {
  label: "request-level",
  url: (id) => `/api/v1/requests/${id}/`,
  mockRequest: (mocks, id, run) => {
    (mocks.collection.findOne as any).mockResolvedValue({ _id: id, run });
  },
};

export const RUN_LEVEL: PathVariant = {
  label: "per-run",
  url: (id) => `/api/v1/requests/${id}/runs/run-1/`,
  mockRequest: (mocks, id, run) => {
    (mocks.collection.findOne as any).mockResolvedValue({ _id: id, run: { ...run, _id: "run-1" } });
  },
};

export const VARIANTS: PathVariant[] = [REQUEST_LEVEL, RUN_LEVEL];

// ─── Blob mock factory ─────────────────────────────────────────────────────

/**
 * Creates the blob mock chain. Call this inside vi.hoisted() in each test file.
 * Returns the mock functions that can be used in vi.mock("@azure/storage-blob", ...).
 */
export function createBlobMocks() {
  const mockDownload = vi.fn();
  const mockGetProperties = vi.fn();
  const mockGetBlockBlobClient = vi.fn().mockReturnValue({
    download: mockDownload,
    getProperties: mockGetProperties,
  });
  const mockGetBlobClient = vi.fn().mockReturnValue({
    download: mockDownload,
    getProperties: mockGetProperties,
  });
  const mockGetContainerClient = vi.fn().mockReturnValue({
    getBlockBlobClient: mockGetBlockBlobClient,
    getBlobClient: mockGetBlobClient,
  });
  return { mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient };
}

/** Re-wire blob mock chain after vi.clearAllMocks(). */
export function rewireBlobMocks(blobMocks: ReturnType<typeof createBlobMocks>): void {
  const { mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient } = blobMocks;
  mockGetBlockBlobClient.mockReturnValue({
    download: mockDownload,
    getProperties: mockGetProperties,
  });
  mockGetBlobClient.mockReturnValue({
    download: mockDownload,
    getProperties: mockGetProperties,
  });
  mockGetContainerClient.mockReturnValue({
    getBlockBlobClient: mockGetBlockBlobClient,
    getBlobClient: mockGetBlobClient,
  });
}
