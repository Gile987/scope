// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Cluster-safe multi-key read for Redis.
 *
 * A native `MGET` is a single multi-key command, so on a clustered Redis (e.g.
 * Azure Cache for Redis Enterprise clustering policy) keys that hash to
 * different slots make it fail with `CROSSSLOT`. This helper instead issues one
 * single-key `GET` per key inside a pipeline (one round-trip). Single-key
 * commands are always routable to their owning slot, so this is correct on
 * standalone and clustered Redis alike. Results are aligned by index with
 * `keys`; a per-key error or non-string value degrades that one entry to `null`
 * rather than discarding the whole batch.
 *
 * Swallowing a cross-slot `MGET` failure into "all missing" is what made the
 * stuck-run reaper falsely reap healthy runs and blanked the runs-list
 * heartbeats (issue #1064). Canonical pattern per StackExchange.Redis#1650:
 * split a cross-slot multi-key op into per-key commands and recombine by index.
 */

/** Minimal pipeline surface used by {@link clusterSafeMget}. */
export interface MgetPipeline {
  get(key: string): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/** Minimal Redis client surface used by {@link clusterSafeMget}. */
export interface MgetCapableRedis {
  pipeline(): MgetPipeline;
}

/**
 * Read multiple keys in a single round-trip without a cross-slot `MGET`.
 *
 * @returns An array the same length and order as `keys`. Each entry is the
 *   string value for a present key, or `null` when the key is missing, the
 *   value is not a string, or that key's command errored. If the pipeline
 *   itself returns `null` (e.g. the connection was torn down), every entry is
 *   `null`.
 */
export async function clusterSafeMget(
  redis: MgetCapableRedis,
  keys: string[],
): Promise<Array<string | null>> {
  if (keys.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.get(key);
  const results = await pipeline.exec();
  if (!results) return keys.map(() => null);

  return keys.map((_, i) => {
    const entry = results[i];
    if (!entry) return null;
    const [err, value] = entry;
    return err || typeof value !== "string" ? null : value;
  });
}
