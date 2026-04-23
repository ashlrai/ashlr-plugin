/**
 * genome-crypto-v2.test.ts — client-side X25519 wrap/unwrap round-trip.
 */

import { describe, it, expect } from "bun:test";
import { randomBytes } from "crypto";

import {
  ENVELOPE_ALG,
  generateKeyPair,
  unwrapDek,
  wrapDek,
} from "../servers/_genome-crypto-v2";

describe("generateKeyPair", () => {
  it("returns 32-byte raw keys encoded base64url", () => {
    const { publicKey, privateKey } = generateKeyPair();
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding).
    expect(publicKey.length).toBeGreaterThanOrEqual(42);
    expect(publicKey.length).toBeLessThanOrEqual(44);
    expect(privateKey.length).toBeGreaterThanOrEqual(42);
    expect(privateKey.length).toBeLessThanOrEqual(44);
  });

  it("two successive generations produce distinct keypairs", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("wrapDek / unwrapDek", () => {
  it("round-trips a 32-byte DEK through the recipient's keypair", () => {
    const alice = generateKeyPair();
    const dek = randomBytes(32);

    const envelope = wrapDek(dek, alice.publicKey);
    expect(typeof envelope).toBe("string");
    expect(envelope.length).toBeGreaterThan(60); // 1 + 32 + 12 + 32 + 16 bytes minimum

    const unwrapped = unwrapDek(envelope, alice.privateKey);
    expect(Buffer.compare(unwrapped, dek)).toBe(0);
  });

  it("two wraps of the same DEK produce distinct ciphertexts (ephemeral pub)", () => {
    const alice = generateKeyPair();
    const dek = randomBytes(32);
    const e1 = wrapDek(dek, alice.publicKey);
    const e2 = wrapDek(dek, alice.publicKey);
    expect(e1).not.toBe(e2);
    // But both unwrap to the same plaintext.
    expect(Buffer.compare(unwrapDek(e1, alice.privateKey), dek)).toBe(0);
    expect(Buffer.compare(unwrapDek(e2, alice.privateKey), dek)).toBe(0);
  });

  it("fails to unwrap with the wrong private key (AEAD tag mismatch)", () => {
    const alice = generateKeyPair();
    const bob   = generateKeyPair();
    const dek = randomBytes(32);
    const envelope = wrapDek(dek, alice.publicKey);
    // Bob tries to unwrap — should throw.
    expect(() => unwrapDek(envelope, bob.privateKey)).toThrow();
  });

  it("rejects a truncated envelope", () => {
    const alice = generateKeyPair();
    expect(() => unwrapDek("AAAA", alice.privateKey)).toThrow(/too short|version/);
  });

  it("rejects unsupported version bytes", () => {
    const alice = generateKeyPair();
    // Craft a minimum-length envelope with version=0xff.
    const bad = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.alloc(32), // eph pub (all zeros)
      Buffer.alloc(12), // nonce
      Buffer.alloc(32), // ct (not used — should fail on version check first)
      Buffer.alloc(16), // tag
    ]);
    expect(() => unwrapDek(bad.toString("base64url"), alice.privateKey)).toThrow(/version/);
  });

  it("ENVELOPE_ALG is stable across wraps (forward-compat ALG string)", () => {
    expect(ENVELOPE_ALG).toBe("x25519-hkdf-sha256-aes256gcm-v1");
  });

  it("rejects DEKs that are not 32 bytes", () => {
    const alice = generateKeyPair();
    expect(() => wrapDek(Buffer.alloc(16), alice.publicKey)).toThrow();
    expect(() => wrapDek(Buffer.alloc(48), alice.publicKey)).toThrow();
  });
});
