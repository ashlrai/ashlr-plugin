/**
 * genome-crypto.test.ts — Unit tests for _genome-crypto.ts
 *
 * Tests:
 *   1.  encrypt/decrypt roundtrip produces original plaintext
 *   2.  wrong key fails with clear error
 *   3.  tamper detection — flip a byte in ciphertext → throws
 *   4.  tamper detection — flip a byte in auth tag → throws
 *   5.  serialize/parse roundtrip is lossless
 *   6.  parseBlob rejects too-short input
 *   7.  version mismatch → decryptSection throws
 *   8.  key file mode is 0600 (owner-only)
 *   9.  loadKey returns null when file does not exist
 *   10. empty plaintext roundtrip
 *   11. large plaintext roundtrip (> 64 KB)
 *   12. base32 encode/decode roundtrip
 */

import { describe, it, expect, afterEach } from "bun:test";
import { stat, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import {
  generateKey,
  encryptSection,
  decryptSection,
  serializeBlob,
  parseBlob,
  loadKey,
  saveKey,
  encodeBase32,
  decodeBase32,
  type EncryptedBlob,
} from "../servers/_genome-crypto.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_GENOME_ID = `test-genome-${process.pid}`;
const keyDir = join(tmpdir(), ".ashlr-test-keys");

// Override key location for tests — patch env is not needed; we call saveKey/loadKey directly.

afterEach(async () => {
  await rm(keyDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("genome-crypto", () => {
  // 1. Roundtrip
  it("encrypt/decrypt roundtrip produces original plaintext", () => {
    const key       = generateKey();
    const plaintext = "# Auth\nThis is secret genome content.";
    const blob      = encryptSection(plaintext, key);
    const result    = decryptSection(blob, key);
    expect(result).toBe(plaintext);
  });

  // 2. Wrong key
  it("wrong key fails with clear error", () => {
    const key1      = generateKey();
    const key2      = generateKey();
    const blob      = encryptSection("secret", key1);
    expect(() => decryptSection(blob, key2)).toThrow(
      /Decryption failed — wrong key or corrupt data/,
    );
  });

  // 3. Tamper ciphertext
  it("flipping a byte in ciphertext throws on decrypt", () => {
    const key  = generateKey();
    const blob = encryptSection("tamper test", key);
    const tampered: EncryptedBlob = {
      ...blob,
      ciphertext: Buffer.from(blob.ciphertext).fill(
        blob.ciphertext[0]! ^ 0xff,
        0,
        1,
      ),
    };
    expect(() => decryptSection(tampered, key)).toThrow(
      /Decryption failed — wrong key or corrupt data/,
    );
  });

  // 4. Tamper auth tag
  it("flipping a byte in auth tag throws on decrypt", () => {
    const key  = generateKey();
    const blob = encryptSection("auth tag test", key);
    const tampered: EncryptedBlob = {
      ...blob,
      authTag: Buffer.from(blob.authTag).fill(blob.authTag[0]! ^ 0x01, 0, 1),
    };
    expect(() => decryptSection(tampered, key)).toThrow(
      /Decryption failed — wrong key or corrupt data/,
    );
  });

  // 5. Serialize/parse roundtrip
  it("serializeBlob/parseBlob roundtrip is lossless", () => {
    const key  = generateKey();
    const blob = encryptSection("round trip", key);
    const str  = serializeBlob(blob);
    const back = parseBlob(str);

    expect(back.version).toBe(blob.version);
    expect(back.nonce.toString("hex")).toBe(blob.nonce.toString("hex"));
    expect(back.authTag.toString("hex")).toBe(blob.authTag.toString("hex"));
    expect(back.ciphertext.toString("hex")).toBe(blob.ciphertext.toString("hex"));
    // Full roundtrip: decrypt from parsed blob
    const plain = decryptSection(back, key);
    expect(plain).toBe("round trip");
  });

  // 6. parseBlob rejects too-short input
  it("parseBlob throws on too-short base64url input", () => {
    expect(() => parseBlob("abc")).toThrow(/too short/);
  });

  // 7. Version mismatch
  it("version mismatch throws on decryptSection", () => {
    const key  = generateKey();
    const blob = encryptSection("version test", key);
    const badVersion: EncryptedBlob = { ...blob, version: 99 };
    expect(() => decryptSection(badVersion, key)).toThrow(/Unknown blob version/);
  });

  // 8. Key file permissions
  // Windows does not honour POSIX mode bits — stat.mode & 0o077 is meaningless there.
  it.skipIf(process.platform === "win32")("key file is written with mode 0600", async () => {
    // Write to a tmp path by calling saveKey with a custom ASHLR_HOME indirection.
    // We call the function directly and verify the file stat.
    const key = generateKey();
    // saveKey uses homedir() — we must test via the actual path.
    // Use a temp genome id unique to this test and clean up.
    const testId = `perm-test-${Date.now()}`;
    await saveKey(testId, key);
    const { homedir } = await import("os");
    const p = join(homedir(), ".ashlr", "team-keys", `${testId}.key`);
    const s = await stat(p);
    // mode & 0o077 === 0 means no group or other bits set
    expect(s.mode & 0o077).toBe(0);
    await rm(p, { force: true });
  });

  // 9. loadKey returns null for missing file
  it("loadKey returns null when key file does not exist", async () => {
    const result = await loadKey(`nonexistent-genome-${Date.now()}`);
    expect(result).toBeNull();
  });

  // 10. Empty plaintext
  it("empty plaintext roundtrip works", () => {
    const key  = generateKey();
    const blob = encryptSection("", key);
    expect(decryptSection(blob, key)).toBe("");
  });

  // 11. Large plaintext (> 64 KB)
  it("large plaintext roundtrip works", () => {
    const key       = generateKey();
    const plaintext = randomBytes(70_000).toString("hex"); // 140 KB string
    const blob      = encryptSection(plaintext, key);
    expect(decryptSection(blob, key)).toBe(plaintext);
  });

  // 12. Base32 encode/decode
  it("base32 encode/decode roundtrip is lossless for a 32-byte key", () => {
    const key     = generateKey();
    const encoded = encodeBase32(key);
    const decoded = decodeBase32(encoded);
    expect(decoded.toString("hex")).toBe(key.toString("hex"));
  });
});
