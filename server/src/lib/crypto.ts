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

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

// Envelope version history:
//   0x01 — AES-256-GCM under the raw master key (legacy; still decrypted for
//          backwards compat with stored GitHub OAuth tokens).
//   0x02 — AES-256-GCM under an HKDF-derived subkey (new writes). Lets the
//          HMAC state key and the AES key be rotated independently.
const VERSION_LEGACY_MASTER = 0x01;
const VERSION_AES_SUBKEY = 0x02;
const VERSION_WRITE = VERSION_AES_SUBKEY;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Domain-separated subkeys derived from the master key via HKDF-SHA256.
 *
 * Using the raw master for both AES-GCM and HMAC is functionally safe today
 * (neither primitive leaks the key) but breaks standard domain separation:
 * a future bug in one domain can cross-contaminate the other, and logging a
 * subkey once exposes both duties. HKDF with distinct info strings costs
 * one hash call per startup and lets either subkey be rotated independently
 * (bump the info version).
 */
const INFO_AES = "ashlr/aes-gcm/v1";
const INFO_HMAC = "ashlr/state-hmac/v1";
function derive(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key(), Buffer.alloc(0), info, 32));
}
let _aesKey: Buffer | null = null;
let _hmacKey: Buffer | null = null;
function aesKey(): Buffer { return (_aesKey ??= derive(INFO_AES)); }
function hmacKey(): Buffer { return (_hmacKey ??= derive(INFO_HMAC)); }

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
  _aesKey = null;
  _hmacKey = null;
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
  const cipher = createCipheriv("aes-256-gcm", aesKey(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([VERSION_WRITE]), nonce, authTag, ct]);
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
  const version = buf[0];
  let decryptKey: Buffer;
  if (version === VERSION_AES_SUBKEY) {
    decryptKey = aesKey();
  } else if (version === VERSION_LEGACY_MASTER) {
    // Read-compat path for envelopes written before the HKDF cutover. New
    // writes use VERSION_AES_SUBKEY; legacy envelopes are transparently
    // re-encrypted whenever the caller rewrites the value (e.g. token
    // refresh).
    decryptKey = key();
  } else {
    throw new Error(`crypto.decrypt: unsupported envelope version ${version}`);
  }
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const authTag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + AUTH_TAG_BYTES);
  const ct = buf.subarray(1 + NONCE_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", decryptKey, nonce);
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
  // Use a domain-separated HMAC subkey rather than the AES master. State
  // tokens have a 10-minute TTL, so there's no on-disk migration concern
  // here; switching is a clean cutover.
  const mac = createHmac("sha256", hmacKey()).update(payload).digest();
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
  const expected = createHmac("sha256", hmacKey()).update(payload).digest();
  const given = fromBase64Url(macPart);
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  return { sid };
}
