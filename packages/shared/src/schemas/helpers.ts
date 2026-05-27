// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Maps a MongoDB document's `_id` field to `id` for API responses.
 * Strips `_id` from the output to ensure only `id` is exposed.
 */
export function mapId<T extends { _id: string }>(doc: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = doc as any;
  return { id: _id, ...rest };
}
