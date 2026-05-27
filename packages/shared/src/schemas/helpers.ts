// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Maps a MongoDB document's `_id` field to `id` for API responses.
 * Strips `_id` from the output so only `id` is exposed to clients.
 * Handles both string _id (common in this codebase) and ObjectId.
 */
export function mapId<T extends { _id: unknown }>(doc: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = doc as any;
  return { id: String(_id), ...rest };
}
