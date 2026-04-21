/**
 * rate-limit.ts — IP-based in-memory rate limiter for auth routes.
 *
 * MVP: simple Map<key, {count, resetAt}>. v1.14 replaces with Redis.
 *
 * Exported helper: ipRateLimit(c, key, max, windowMs)
 *   - Returns a 429 Response if the key has exceeded max calls in windowMs.
 *   - Returns null if the request is allowed.
 *   - Fails open on IP parse errors (never blocks legitimate traffic).
 */

import type { Context } from "hono";

interface IpBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, IpBucket>();

/**
 * Extract the client IP from Hono context. Prefers X-Forwarded-For (first
 * hop), falls back to X-Real-IP, then "unknown". Never throws.
 */
export function extractIp(c: Context): string {
  try {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const xri = c.req.header("x-real-ip");
    if (xri) return xri.trim();
  } catch {
    // fail-open
  }
  return "unknown";
}

/**
 * Check whether the given key (typically `<route>:<ip>`) has exceeded the
 * rate limit. Increments the counter on every call.
 *
 * @param c         Hono context (used to extract IP and build response)
 * @param key       Arbitrary string key scoping the bucket
 * @param max       Maximum allowed calls per window
 * @param windowMs  Window size in milliseconds
 * @returns  A 429 Response if rate-limited, null if the call is allowed.
 */
export function ipRateLimit(
  c: Context,
  key: string,
  max: number,
  windowMs: number,
): Response | null {
  const now = Date.now();
  let bucket = ipBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    ipBuckets.set(key, bucket);
  }

  bucket.count += 1;

  if (bucket.count > max) {
    return c.json(
      { error: "Too many requests. Please try again later." },
      429,
    ) as unknown as Response;
  }

  return null;
}

/** Test helper: clear all IP buckets. */
export function _clearIpBuckets(): void {
  ipBuckets.clear();
}

/** Test helper: peek at a bucket without incrementing. */
export function _getBucket(key: string): IpBucket | undefined {
  return ipBuckets.get(key);
}
