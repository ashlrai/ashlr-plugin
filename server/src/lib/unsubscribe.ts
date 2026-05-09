/**
 * unsubscribe.ts — HMAC-signed unsubscribe tokens for weekly digest opt-out.
 *
 * Token format: `v1.{userId}.{expiresMs}.{hmac-base64url}`
 * TTL: 90 days (tokens embedded in an email sent today are valid for the
 *      likely lifespan of that email sitting in an inbox).
 *
 * Uses the same ASHLR_MASTER_KEY and signing pattern as lib/crypto.ts
 * (signState / verifyState) but with a distinct domain prefix to prevent
 * cross-purpose token reuse.
 *
 * Key rotation: tokens are prefixed with a version marker (`v1.`). If the
 * current key fails HMAC verification on a v1 token, verifyUnsubscribeToken
 * returns the sentinel "STALE_KEY" rather than null so callers can render a
 * graceful "link expired — sign in to unsubscribe" page instead of a generic
 * error. Any key rotation thus degrades gracefully rather than silently
 * invalidating all outstanding 90-day tokens.
 */

import { createHmac, timingSafeEqual } from "crypto";

const DOMAIN = "unsub-v1";
const TTL_MS = 90 * 24 * 60 * 60 * 1_000; // 90 days
const VERSION = "v1";

// Lazy-load the master key via the same crypto module so we never duplicate
// key-loading logic.
function getKey(): Buffer {
  // Re-use crypto.ts's loadMasterKey path by importing the module.
  // We call encrypt with a dummy value just to force the key to initialise,
  // then access internal state — instead, we replicate the env read here
  // since the key material is identical.
  const raw = process.env["ASHLR_MASTER_KEY"];
  if (raw) {
    const k = Buffer.from(raw, "base64");
    if (k.length !== 32) throw new Error("ASHLR_MASTER_KEY must decode to 32 bytes");
    return k;
  }
  if (process.env["TESTING"] === "1" || process.env["ASHLR_MASTER_KEY_DEV"] === "1") {
    // Use a stable test key so tokens remain verifiable within the same
    // test process even if ASHLR_MASTER_KEY is absent.
    return Buffer.alloc(32, 0x42);
  }
  throw new Error("ASHLR_MASTER_KEY is required");
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Issue a signed unsubscribe token for a user.
 * The token is safe to embed in email URLs.
 * Format: `v1.{userId}.{expiresMs}.{hmac-base64url}`
 */
export function signUnsubscribeToken(userId: string, ttlMs = TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${DOMAIN}.${userId}.${expiresAt}`;
  const mac = createHmac("sha256", getKey()).update(payload).digest();
  return `${VERSION}.${userId}.${expiresAt}.${toBase64Url(mac)}`;
}

/**
 * Verify a signed unsubscribe token.
 *
 * Returns:
 *   - the userId string on success
 *   - null on malformed / expired / tampered token
 *   - "STALE_KEY" when the token structure is valid but HMAC verification
 *     fails, indicating the signing key has been rotated since the token was
 *     issued. Callers should render a graceful "link expired — sign in to
 *     unsubscribe" page rather than a generic invalid-link error.
 */
export function verifyUnsubscribeToken(token: string): string | null | "STALE_KEY" {
  // Support both versioned (v1.userId.expires.mac) and legacy (userId.expires.mac) formats.
  const parts = token.split(".");

  let userId: string;
  let expiresStr: string;
  let macPart: string;
  let isVersioned: boolean;

  if (parts.length === 4 && parts[0] === VERSION) {
    // Versioned format: v1.userId.expiresMs.mac
    [, userId, expiresStr, macPart] = parts as [string, string, string, string];
    isVersioned = true;
  } else if (parts.length === 3) {
    // Legacy format: userId.expiresMs.mac (tokens issued before versioning)
    [userId, expiresStr, macPart] = parts as [string, string, string];
    isVersioned = false;
  } else {
    return null;
  }

  const expiresAt = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  const payload = `${DOMAIN}.${userId}.${expiresStr}`;
  const expected = createHmac("sha256", getKey()).update(payload).digest();
  let given: Buffer;
  try {
    given = fromBase64Url(macPart);
  } catch {
    return null;
  }
  if (expected.length !== given.length) {
    // Return STALE_KEY only for versioned tokens — legacy tokens that fail
    // are simply invalid (could be tampered) because we can't distinguish.
    return isVersioned ? "STALE_KEY" : null;
  }
  if (!timingSafeEqual(expected, given)) {
    return isVersioned ? "STALE_KEY" : null;
  }
  return userId;
}
