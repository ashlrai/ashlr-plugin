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
 * Extract the client IP from Hono context.
 *
 * Previous behavior took the leftmost X-Forwarded-For entry, which is
 * attacker-controlled (clients can inject any XFF value). That reduced every
 * per-IP rate limit to security theater: an attacker rotates the header per
 * request and each call hits a fresh bucket.
 *
 * New precedence:
 *   1. ASHLR_TRUSTED_PROXY_HEADER — operator-declared edge-verified header
 *      (e.g. "Fly-Client-IP" on Fly.io, "CF-Connecting-IP" on Cloudflare,
 *      "True-Client-IP" on Akamai). Set this in production.
 *   2. X-Real-IP — typically written by a reverse proxy the operator controls.
 *   3. X-Forwarded-For RIGHTMOST — the last hop before us. Still spoofable in
 *      setups without any edge proxy, but strictly better than leftmost.
 *   4. "unknown" — fail closed: one shared bucket for all unknown IPs so a
 *      request missing all IP headers can't evade limits by bouncing between
 *      non-existent buckets.
 */
const TRUSTED_HEADER = process.env["ASHLR_TRUSTED_PROXY_HEADER"] ?? "fly-client-ip";

export function extractIp(c: Context): string {
  try {
    const trusted = c.req.header(TRUSTED_HEADER);
    if (trusted) {
      const v = trusted.trim();
      if (v) return v;
    }
    const xri = c.req.header("x-real-ip");
    if (xri) return xri.trim();
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1]!;
    }
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
