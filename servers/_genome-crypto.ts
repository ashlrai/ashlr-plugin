/**
 * _genome-crypto.ts — Client-side AES-256-GCM encryption for team genome sections.
 *
 * Threat model:
 *   - Server operator cannot read section content without the team key.
 *   - Compromised Redis / S3 / Postgres exposes only ciphertext + nonce + auth tag.
 *   - TLS protects the transport layer; encryption here provides defence-in-depth.
 *   - A user who leaves the team loses access to new content after a key rotation.
 *
 * v1 model: one symmetric AES-256-GCM key per genome, stored at
 *   ~/.ashlr/team-keys/<genomeId>.key  (mode 0600, 32 raw bytes)
 *
 * Wire format (serializeBlob):
 *   base64url(<version_byte> : <12-byte nonce> : <16-byte authTag> : <ciphertext>)
 *   The version prefix allows future algorithm migration without breaking parsers.
 *
 * Multi-user model (v2, not shipped):
 *   Each member holds an X25519 keypair. The team key is wrapped per member:
 *     envelope[memberId] = encrypt(memberPublicKey, teamKey)
 *   Admin manages envelopes. Member rotation = re-wrap envelope (no re-encrypt needed).
 *   Full protocol documented in docs/team-genome.md.
 *
 * SECURITY: This module NEVER logs key material, plaintext content, or nonces.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// Emit a one-time-per-process warning on Windows since POSIX chmod has no
// effect on NTFS. We don't throw — the key file is still written; the user
// should protect ~/.ashlr/team-keys/ via BitLocker or Windows EFS.
let _warnedWindowsChmod = false;
function warnWindowsChmod(p: string): void {
  if (_warnedWindowsChmod) return;
  _warnedWindowsChmod = true;
  process.stderr.write(
    `[ashlr-genome-crypto] WARNING: Running on Windows — chmod 0600 has no effect on NTFS. ` +
    `Key file at ${p} is not restricted by POSIX ACLs. ` +
    `Protect ~/.ashlr/team-keys/ using BitLocker or Windows EFS.\n`,
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_BYTES    = 32;          // AES-256
const NONCE_BYTES  = 12;          // GCM recommended nonce size
const AUTH_TAG_BYTES = 16;        // GCM authentication tag (128-bit)
const BLOB_VERSION = 1;

// Regex that matches our serialized blob format (base64url)
// Used by the server to detect encrypted vs plaintext content.
export const ENCRYPTED_BLOB_RE = /^[A-Za-z0-9_-]{20,}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedBlob {
  version:    number;
  nonce:      Buffer;
  authTag:    Buffer;
  ciphertext: Buffer;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/** Generate a new 32-byte AES-256 team key. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext section with AES-256-GCM.
 * Each call uses a fresh random nonce — never reuse a nonce with the same key.
 */
export function encryptSection(plaintext: string, key: Buffer): EncryptedBlob {
  if (key.length !== KEY_BYTES) {
    throw new Error(`[ashlr-genome-crypto] Key must be ${KEY_BYTES} bytes`);
  }
  const nonce  = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct     = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { version: BLOB_VERSION, nonce, authTag, ciphertext: ct };
}

/**
 * Decrypt a section blob.
 * Throws if the auth tag does not match (tampered data or wrong key).
 * Throws on version mismatch.
 */
export function decryptSection(blob: EncryptedBlob, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`[ashlr-genome-crypto] Key must be ${KEY_BYTES} bytes`);
  }
  if (blob.version !== BLOB_VERSION) {
    throw new Error(`[ashlr-genome-crypto] Unknown blob version: ${blob.version}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce);
  decipher.setAuthTag(blob.authTag);
  try {
    const plain = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
    return plain.toString("utf-8");
  } catch {
    // Node throws "Unsupported state or unable to authenticate data" on auth tag failure.
    throw new Error("[ashlr-genome-crypto] Decryption failed — wrong key or corrupt data");
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an EncryptedBlob to a compact base64url string.
 * Layout: [ version(1) | nonce(12) | authTag(16) | ciphertext(variable) ]
 */
export function serializeBlob(blob: EncryptedBlob): string {
  const header = Buffer.alloc(1 + NONCE_BYTES + AUTH_TAG_BYTES);
  header.writeUInt8(blob.version, 0);
  blob.nonce.copy(header, 1);
  blob.authTag.copy(header, 1 + NONCE_BYTES);
  const full = Buffer.concat([header, blob.ciphertext]);
  // base64url (no padding, URL-safe)
  return full.toString("base64url");
}

/**
 * Parse a base64url blob string back into an EncryptedBlob.
 * Throws on malformed input.
 */
export function parseBlob(str: string): EncryptedBlob {
  let buf: Buffer;
  try {
    buf = Buffer.from(str, "base64url");
  } catch {
    throw new Error("[ashlr-genome-crypto] Invalid blob: base64url decode failed");
  }
  const minLen = 1 + NONCE_BYTES + AUTH_TAG_BYTES;
  if (buf.length < minLen) {
    throw new Error(`[ashlr-genome-crypto] Invalid blob: too short (${buf.length} bytes)`);
  }
  const version  = buf.readUInt8(0);
  const nonce    = buf.subarray(1, 1 + NONCE_BYTES);
  const authTag  = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(1 + NONCE_BYTES + AUTH_TAG_BYTES);
  return {
    version,
    nonce:      Buffer.from(nonce),
    authTag:    Buffer.from(authTag),
    ciphertext: Buffer.from(ciphertext),
  };
}

// ---------------------------------------------------------------------------
// Key file helpers
// ---------------------------------------------------------------------------

function keyFilePath(genomeId: string): string {
  return join(homedir(), ".ashlr", "team-keys", `${genomeId}.key`);
}

/**
 * Load a team key from ~/.ashlr/team-keys/<genomeId>.key.
 * Returns null if the file does not exist.
 * Throws if the file exists but is malformed.
 */
export async function loadKey(genomeId: string): Promise<Buffer | null> {
  const p = keyFilePath(genomeId);
  if (!existsSync(p)) return null;
  const raw = await readFile(p);
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `[ashlr-genome-crypto] Key file at ${p} has wrong length (${raw.length} bytes, expected ${KEY_BYTES})`,
    );
  }
  return Buffer.from(raw);
}

/**
 * Save a team key to ~/.ashlr/team-keys/<genomeId>.key with mode 0600.
 * Creates parent directories as needed.
 */
export async function saveKey(genomeId: string, key: Buffer): Promise<void> {
  if (key.length !== KEY_BYTES) {
    throw new Error(`[ashlr-genome-crypto] Key must be ${KEY_BYTES} bytes`);
  }
  const p = keyFilePath(genomeId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, key, { mode: 0o600 });
  if (process.platform === "win32") {
    warnWindowsChmod(p);
  } else {
    // chmod explicitly in case writeFile mode is masked by umask
    await chmod(p, 0o600);
  }
}

// ---------------------------------------------------------------------------
// Base32 helpers (for human-friendly key export/import)
// ---------------------------------------------------------------------------

// RFC 4648 base32 alphabet (uppercase, no padding issues with 32-byte keys)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode a Buffer as base32 (no padding). */
export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decode a base32 string to a Buffer. Throws on invalid characters. */
export function decodeBase32(str: string): Buffer {
  const s = str.toUpperCase().replace(/\s/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`[ashlr-genome-crypto] Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
