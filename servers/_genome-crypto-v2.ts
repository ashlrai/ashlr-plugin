/**
 * _genome-crypto-v2.ts — client-side v2 envelope encryption for team genomes.
 *
 * The server (Phase T1) stores opaque wrapped-DEK envelopes keyed by
 * `(genome_id, member_user_id)`. This module implements the crypto that
 * the CLIENT does on either side of that store:
 *
 *   - Admin: wraps the team DEK for each recipient's X25519 pubkey once,
 *            then uploads the envelope via POST /genome/:id/key-envelope.
 *   - Member: fetches their envelope via GET /genome/:id/key-envelope,
 *             unwraps with their own X25519 privkey, uses the DEK to
 *             decrypt genome section content via the existing v1 AES-GCM
 *             content-encryption path.
 *
 * Construction:
 *   1. Generate ephemeral X25519 keypair.
 *   2. ECDH with recipient pubkey → shared secret (32 bytes).
 *   3. HKDF-SHA256(secret, salt=empty, info="ashlr.genome.v2") → 32-byte AES key.
 *   4. AES-256-GCM(key, nonce=12B random, aad="ashlr.genome.v2") wraps the DEK.
 *   5. Envelope layout (base64url, concatenated):
 *        [ 1 byte version=0x01 ]
 *        [ 32 byte ephemeral-public ]
 *        [ 12 byte nonce ]
 *        [ N byte ciphertext ]
 *        [ 16 byte auth tag ]
 *
 * Why ephemeral: forward secrecy per envelope (compromising the recipient's
 * private key later does not let an attacker decrypt a captured envelope
 * unless they also captured the ephemeral private at wrap time, which we
 * discard).
 *
 * Why HKDF(info="ashlr.genome.v2"): domain separation from any future v3.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "crypto";

const VERSION = 0x01;
const HKDF_INFO = Buffer.from("ashlr.genome.v2", "utf-8");
const AEAD_AAD = Buffer.from("ashlr.genome.v2", "utf-8");
const AEAD_NONCE_LEN = 12;
const AEAD_TAG_LEN = 16;

// ---------------------------------------------------------------------------
// base64url helpers — Node 20+ has native support via Buffer.toString("base64url").
// ---------------------------------------------------------------------------

function b64url(b: Buffer): string { return b.toString("base64url"); }
function fromB64url(s: string): Buffer { return Buffer.from(s, "base64url"); }

// ---------------------------------------------------------------------------
// X25519 keypair generation
// ---------------------------------------------------------------------------

export interface KeyPair {
  /** Raw 32-byte X25519 public key, base64url-encoded. */
  publicKey: string;
  /** Raw 32-byte X25519 private key, base64url-encoded. Keep offline. */
  privateKey: string;
}

/**
 * Generate an X25519 keypair. Keys are returned as 32-byte raw values in
 * base64url. Both sides of the wire use the same encoding.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  // Node's key objects are DER-wrapped by default; we want raw 32-byte values.
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  return {
    // The last 32 bytes of an X25519 SPKI DER blob are the raw public key.
    publicKey:  b64url(pubDer.subarray(pubDer.length - 32)),
    // The last 32 bytes of an X25519 PKCS8 DER blob are the raw private key.
    privateKey: b64url(privDer.subarray(privDer.length - 32)),
  };
}

// ---------------------------------------------------------------------------
// Raw-key → Node KeyObject helpers
// ---------------------------------------------------------------------------

// RFC 8410 DER prefix for an X25519 public key SPKI: 12 bytes, followed by the
// 32-byte raw public key. Hand-rolled because Node's API wants the full SPKI.
const X25519_PUB_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

// RFC 8410 DER prefix for an X25519 private key PKCS8: 16 bytes, followed by
// a 2-byte OCTET STRING header + 32-byte raw private key.
const X25519_PRIV_PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x04, 0x22, 0x04, 0x20,
]);

function rawToPubKeyObject(raw32: Buffer) {
  if (raw32.length !== 32) throw new Error("X25519 pubkey must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([X25519_PUB_SPKI_PREFIX, raw32]),
    format: "der",
    type: "spki",
  });
}

function rawToPrivKeyObject(raw32: Buffer) {
  if (raw32.length !== 32) throw new Error("X25519 privkey must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([X25519_PRIV_PKCS8_PREFIX, raw32]),
    format: "der",
    type: "pkcs8",
  });
}

// ---------------------------------------------------------------------------
// Wrap / Unwrap
// ---------------------------------------------------------------------------

export const ENVELOPE_ALG = "x25519-hkdf-sha256-aes256gcm-v1";

/**
 * Wrap a 32-byte DEK for a recipient whose raw X25519 pubkey we have.
 * Returns a base64url-encoded envelope string.
 */
export function wrapDek(dek: Buffer, recipientPubB64url: string): string {
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes");

  const recipientPubRaw = fromB64url(recipientPubB64url);
  if (recipientPubRaw.length !== 32) {
    throw new Error("recipient pubkey must decode to 32 bytes");
  }
  const recipientPub = rawToPubKeyObject(recipientPubRaw);

  // Ephemeral keypair → ECDH → HKDF → AES key.
  const eph = generateKeyPairSync("x25519");
  const ephPubRaw = eph.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);

  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));

  const nonce = randomBytes(AEAD_NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  cipher.setAAD(AEAD_AAD);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.concat([
    Buffer.from([VERSION]),
    ephPubRaw,
    nonce,
    ct,
    tag,
  ]);
  return b64url(envelope);
}

/**
 * Unwrap an envelope produced by wrapDek. Throws on version mismatch, length
 * mismatch, or AEAD tag mismatch (including wrong recipient privkey).
 */
export function unwrapDek(envelopeB64url: string, recipientPrivB64url: string): Buffer {
  const envelope = fromB64url(envelopeB64url);
  // 1 version + 32 eph-pub + 12 nonce + 16 tag = 61 min; plus ciphertext (= DEK size).
  if (envelope.length < 1 + 32 + AEAD_NONCE_LEN + AEAD_TAG_LEN) {
    throw new Error("envelope too short");
  }
  if (envelope[0] !== VERSION) {
    throw new Error(`unsupported envelope version ${envelope[0]}`);
  }
  const ephPubRaw  = envelope.subarray(1, 33);
  const nonce      = envelope.subarray(33, 33 + AEAD_NONCE_LEN);
  const ct         = envelope.subarray(33 + AEAD_NONCE_LEN, envelope.length - AEAD_TAG_LEN);
  const tag        = envelope.subarray(envelope.length - AEAD_TAG_LEN);

  const recipientPrivRaw = fromB64url(recipientPrivB64url);
  if (recipientPrivRaw.length !== 32) {
    throw new Error("recipient privkey must decode to 32 bytes");
  }
  const recipientPriv = rawToPrivKeyObject(recipientPrivRaw);
  const ephPub = rawToPubKeyObject(ephPubRaw);

  const shared = diffieHellman({ privateKey: recipientPriv, publicKey: ephPub });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));

  const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAAD(AEAD_AAD);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (pt.length !== 32) throw new Error("unwrapped DEK has wrong length");
  return pt;
}

// ---------------------------------------------------------------------------
// Local key storage — ~/.ashlr/member-keys/<userId>.json
// ---------------------------------------------------------------------------

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export function memberKeyPath(userId: string): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "member-keys", `${userId}.json`);
}

export interface StoredKeypair {
  userId:     string;
  publicKey:  string;
  privateKey: string;
  alg:        string;  // "x25519-v1"
  createdAt:  string;  // ISO
}

/**
 * Persist a keypair to disk. File mode 0600 because it contains the private
 * key. Directory created lazily with mode 0700.
 */
export function saveKeypair(kp: StoredKeypair): string {
  const path = memberKeyPath(kp.userId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(kp, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on fs that doesn't support it */ }
  return path;
}

export function loadKeypair(userId: string): StoredKeypair | null {
  const path = memberKeyPath(userId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StoredKeypair;
  } catch {
    return null;
  }
}
