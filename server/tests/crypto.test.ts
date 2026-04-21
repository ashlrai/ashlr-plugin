/**
 * crypto.test.ts — AES-256-GCM envelope + signed-state helpers.
 *
 * Ensures the foundation building blocks used by the GitHub OAuth flow do
 * what they claim before any route code depends on them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";

import { __resetKeyForTests, decrypt, encrypt, signState, verifyState } from "../src/lib/crypto.js";

const FIXED_KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env["ASHLR_MASTER_KEY"] = FIXED_KEY;
  __resetKeyForTests();
});

afterEach(() => {
  delete process.env["ASHLR_MASTER_KEY"];
  delete process.env["TESTING"];
  delete process.env["ASHLR_MASTER_KEY_DEV"];
  __resetKeyForTests();
});

describe("encrypt/decrypt", () => {
  test("round-trips a string", () => {
    const ct = encrypt("hello world");
    expect(typeof ct).toBe("string");
    expect(ct).not.toContain("hello");
    expect(decrypt(ct)).toBe("hello world");
  });

  test("produces a different ciphertext each call (random nonce)", () => {
    const a = encrypt("same plaintext");
    const b = encrypt("same plaintext");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same plaintext");
    expect(decrypt(b)).toBe("same plaintext");
  });

  test("rejects truncated envelopes", () => {
    const ct = encrypt("secret");
    expect(() => decrypt(ct.slice(0, 8))).toThrow();
  });

  test("rejects tampered ciphertext", () => {
    const ct = encrypt("secret");
    // Flip one byte near the end (inside ciphertext region).
    const mangled = ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A");
    expect(() => decrypt(mangled)).toThrow();
  });

  test("fails fast when master key size is wrong", () => {
    process.env["ASHLR_MASTER_KEY"] = Buffer.from("too-short").toString("base64");
    __resetKeyForTests();
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });

  test("requires ASHLR_MASTER_KEY in production", () => {
    delete process.env["ASHLR_MASTER_KEY"];
    delete process.env["TESTING"];
    delete process.env["ASHLR_MASTER_KEY_DEV"];
    __resetKeyForTests();
    expect(() => encrypt("x")).toThrow(/required in production/);
  });

  test("ASHLR_MASTER_KEY_DEV=1 generates an ephemeral key", () => {
    delete process.env["ASHLR_MASTER_KEY"];
    process.env["ASHLR_MASTER_KEY_DEV"] = "1";
    __resetKeyForTests();
    const ct = encrypt("devsecret");
    expect(decrypt(ct)).toBe("devsecret");
  });

  test("TESTING=1 also generates an ephemeral key", () => {
    delete process.env["ASHLR_MASTER_KEY"];
    process.env["TESTING"] = "1";
    __resetKeyForTests();
    const ct = encrypt("test");
    expect(decrypt(ct)).toBe("test");
  });
});

describe("signState / verifyState", () => {
  test("round-trips sid", () => {
    const state = signState("cli-session-abc");
    const out = verifyState(state);
    expect(out?.sid).toBe("cli-session-abc");
  });

  test("rejects altered payload", () => {
    const state = signState("sid-1");
    const bad = state.replace("sid-1", "sid-2");
    expect(verifyState(bad)).toBeNull();
  });

  test("rejects altered signature", () => {
    const state = signState("sid-1");
    const parts = state.split(".");
    parts[2] = parts[2]!.slice(0, -1) + (parts[2]!.endsWith("A") ? "B" : "A");
    expect(verifyState(parts.join("."))).toBeNull();
  });

  test("rejects malformed state (wrong part count)", () => {
    expect(verifyState("not.a.valid.state.token")).toBeNull();
    expect(verifyState("no-dots")).toBeNull();
    expect(verifyState("")).toBeNull();
  });

  test("rejects expired state", () => {
    // TTL 1 ms — already stale by the time verifyState runs.
    const state = signState("sid-x", 1);
    // Sleep a tick so Date.now() clearly exceeds expiry.
    const until = Date.now() + 5;
    while (Date.now() < until) {
      // busy wait — Bun.sleep would still count the 1ms window as expired.
    }
    expect(verifyState(state)).toBeNull();
  });

  test("hex-style sid (the OAuth callback shape) round-trips cleanly", () => {
    // The OAuth flow generates sids via randomBytes(16).toString('hex') —
    // 32 chars of [0-9a-f]. No separator ambiguity; this is the happy path.
    const sid = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const state = signState(sid);
    expect(verifyState(state)?.sid).toBe(sid);
  });
});
