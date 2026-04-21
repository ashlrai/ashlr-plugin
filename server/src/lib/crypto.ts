/**
 * crypto.ts — AES-256-GCM envelope encryption for secrets at rest.
 *
 * Used primarily for GitHub OAuth access tokens stored in the users table.
 * Wire format (base64url-encoded):
 *
 *   [ version(1 byte) | nonce(12 bytes) | authTag(16 bytes) | ciphertext(N) ]
 *
 * The master key is read once at module import time from the `ASHLR_MASTER_KEY`
 * env var (base64-encoded 32 raw bytes). Tests + dev environments may set
 * `ASHLR_MASTER_KEY_DEV` to auto-generate an ephemeral key on first use —
 * production must provide a stable key or the module throws on import.
 *
 * Key generation:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const VERSION = 0x01;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function loadMasterKey(): Buffer {
  const raw = process.env["ASHLR_MASTER_KEY"];
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error(
        `ASHLR_MASTER_KEY must decode to 32 bytes (got ${key.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    return key;
  }
  // Dev/test fallback — ephemeral key for this process only. Production MUST
  // set ASHLR_MASTER_KEY so the same ciphertext can be decrypted across
  // restarts.
  if (process.env["TESTING"] === "1" || process.env["ASHLR_MASTER_KEY_DEV"] === "1") {
    const generated = randomBytes(32);
    // eslint-disable-next-line no-console
    console.warn(
      "[crypto] ASHLR_MASTER_KEY not set — using ephemeral dev key. Any data encrypted in this process cannot survive a restart.",
    );
    return generated;
  }
  throw new Error(
    "ASHLR_MASTER_KEY is required in production. Set a 32-byte base64-encoded key, or set ASHLR_MASTER_KEY_DEV=1 for a non-persistent dev key.",
  );
}

let _key: Buffer | null = null;
function key(): Buffer {
  if (!_key) _key = loadMasterKey();
  return _key;
}

/** Test helper: drop the cached master key so the next call re-reads env. */
export function __resetKeyForTests(): void {
  _key = null;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Encrypt plaintext with AES-256-GCM. Returns a base64url-encoded envelope
 * that contains the version byte, a fresh random nonce, the auth tag, and the
 * ciphertext. Safe to store in TEXT columns or emit in JSON.
 */
export function encrypt(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([VERSION]), nonce, authTag, ct]);
  return toBase64Url(envelope);
}

/**
 * Decrypt a base64url-encoded envelope produced by {@link encrypt}. Throws on
 * version mismatch, truncation, or auth-tag failure. Callers in the auth
 * hot path should treat any exception as "token unusable" and force the user
 * to re-authenticate rather than leak plaintext errors.
 */
export function decrypt(envelope: string): string {
  const buf = fromBase64Url(envelope);
  if (buf.length < 1 + NONCE_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("crypto.decrypt: envelope truncated");
  }
  if (buf[0] !== VERSION) {
    throw new Error(`crypto.decrypt: unsupported envelope version ${buf[0]}`);
  }
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const authTag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + AUTH_TAG_BYTES);
  const ct = buf.subarray(1 + NONCE_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Compute an HMAC-signed OAuth state token. `sid` identifies the CLI session
 * waiting for the callback; the timestamp enforces a TTL so stolen or
 * replayed state values expire quickly. Format: `{sid}.{expiresMs}.{hmac}`.
 *
 * The state token is opaque to clients — the backend generates it on /start
 * and validates it on /callback.
 */
export function signState(sid: string, ttlMs: number = 10 * 60_000): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${sid}.${expiresAt}`;
  const { createHmac } = require("crypto") as typeof import("crypto");
  const mac = createHmac("sha256", key()).update(payload).digest();
  return `${payload}.${toBase64Url(mac)}`;
}

/**
 * Verify a signed state token and return the embedded sid. Returns null on
 * any mismatch or expiry — callers should refuse the callback when null.
 * Uses a constant-time compare to defeat timing side-channels.
 */
export function verifyState(state: string): { sid: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [sid, expiresStr, macPart] = parts as [string, string, string];
  const expiresAt = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  const payload = `${sid}.${expiresStr}`;
  const { createHmac, timingSafeEqual } = require("crypto") as typeof import("crypto");
  const expected = createHmac("sha256", key()).update(payload).digest();
  const given = fromBase64Url(macPart);
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  return { sid };
}
