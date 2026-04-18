/**
 * ratelimit.ts — In-memory token-bucket rate limiter.
 *
 * MVP implementation: one bucket per string key (API token).
 * Phase 3 can replace with a Redis-backed sliding window.
 *
 * Default: 1 request per 10 seconds per key.
 */

interface Bucket {
  /** Epoch ms of the last request. */
  lastRequestAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Returns true if the request is allowed, false if rate-limited.
 *
 * @param key          Unique key (API token, IP, etc.)
 * @param windowMs     Minimum ms between requests (default 10_000)
 */
export function checkRateLimit(key: string, windowMs = 10_000): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket) {
    buckets.set(key, { lastRequestAt: now });
    return true;
  }

  if (now - bucket.lastRequestAt < windowMs) {
    return false;
  }

  bucket.lastRequestAt = now;
  return true;
}

/** Test helper: clear all buckets. */
export function _clearBuckets(): void {
  buckets.clear();
}

/** Test helper: backdate a key's last request to simulate time passing. */
export function _backdateBucket(key: string, msAgo: number): void {
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.lastRequestAt = Date.now() - msAgo;
  } else {
    buckets.set(key, { lastRequestAt: Date.now() - msAgo });
  }
}
