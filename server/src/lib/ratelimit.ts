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

// ---------------------------------------------------------------------------
// Sliding-window rate limiter (Phase 2 — LLM summarizer)
//
// Tracks request timestamps in a circular array; allows up to `maxRequests`
// per `windowMs`. More accurate than the simple token-bucket above.
// ---------------------------------------------------------------------------

interface SlidingWindow {
  timestamps: number[];
}

const slidingWindows = new Map<string, SlidingWindow>();

/**
 * Returns true if the request is allowed under a sliding-window limit.
 *
 * @param key         Unique key (e.g. "llm_summarize:<token>")
 * @param windowMs    Rolling window size in ms (e.g. 60_000 for 1 minute)
 * @param maxRequests Maximum allowed requests within the window
 */
export function checkRateLimitBucket(key: string, windowMs: number, maxRequests: number): boolean {
  const now    = Date.now();
  const cutoff = now - windowMs;

  let win = slidingWindows.get(key);
  if (!win) {
    win = { timestamps: [] };
    slidingWindows.set(key, win);
  }

  // Evict expired timestamps
  win.timestamps = win.timestamps.filter((t) => t > cutoff);

  if (win.timestamps.length >= maxRequests) {
    return false;
  }

  win.timestamps.push(now);
  return true;
}

/** Test helper: clear all sliding-window state. */
export function _clearSlidingWindows(): void {
  slidingWindows.clear();
}
