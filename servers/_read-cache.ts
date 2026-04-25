/**
 * _read-cache — per-process content cache for ashlr__read.
 *
 * Keyed by absolute path; the cached result is only reused when the file's
 * mtimeMs matches — any write (ours via ashlr__edit, or external) invalidates.
 * Lives for the MCP server lifetime, which aligns with a single Claude Code
 * session.
 *
 * Module-level singleton. All consumers (read-server, edit-server) import
 * the same instance.
 */

export interface ReadCacheEntry {
  mtimeMs: number;
  /** The exact string we would have returned on a miss. */
  result: string;
  /** Bytes of the original file when cached — for correct savings math on reuse. */
  sourceBytes: number;
}

const readCache: Map<string, ReadCacheEntry> = new Map();

/** Return the cached entry for `abs`, or undefined if absent. */
export function getCached(abs: string): ReadCacheEntry | undefined {
  return readCache.get(abs);
}

/** Store a cache entry for `abs`. */
export function setCached(abs: string, entry: ReadCacheEntry): void {
  readCache.set(abs, entry);
}

/**
 * Invalidate the cache entry for `abs` so the next read fetches fresh
 * content. Called by edit-server immediately after a successful write.
 *
 * Sets mtimeMs to -1 (guaranteed mismatch against any real stat) rather than
 * deleting so that a concurrent read that already looked up the entry will
 * still see a miss when it compares mtimes.
 */
export function invalidateCached(abs: string): void {
  const hit = readCache.get(abs);
  if (hit) readCache.set(abs, { ...hit, mtimeMs: -1 });
}
