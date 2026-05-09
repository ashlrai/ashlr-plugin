/**
 * unsubscribe.test.ts — Unit tests for lib/unsubscribe.ts token signing/verification.
 *
 * Covers (Fix 4 — key rotation versioning):
 *   1. signUnsubscribeToken produces a v1-prefixed token
 *   2. verifyUnsubscribeToken returns userId for a valid v1 token
 *   3. verifyUnsubscribeToken returns "STALE_KEY" when HMAC fails on a v1 token
 *      (simulates key rotation)
 *   4. verifyUnsubscribeToken returns null for a malformed token
 *   5. verifyUnsubscribeToken returns null for an expired token
 *   6. Legacy 3-part tokens (pre-versioning) that pass HMAC still resolve
 */

import { describe, it, expect } from "bun:test";
import { createHmac } from "crypto";

process.env["TESTING"] = "1";

import { signUnsubscribeToken, verifyUnsubscribeToken } from "../src/lib/unsubscribe.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a raw v1 token signed with a different key (simulates rotation). */
function signWithKey(userId: string, key: Buffer, ttlMs = 90 * 24 * 60 * 60 * 1_000): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `unsub-v1.${userId}.${expiresAt}`;
  const mac = createHmac("sha256", key).update(payload).digest();
  const b64url = mac.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `v1.${userId}.${expiresAt}.${b64url}`;
}

/** Build a legacy 3-part token (no version prefix) signed with the test key (0x42 * 32). */
function signLegacyWithTestKey(userId: string, ttlMs = 90 * 24 * 60 * 60 * 1_000): string {
  const key = Buffer.alloc(32, 0x42);
  const expiresAt = Date.now() + ttlMs;
  const payload = `unsub-v1.${userId}.${expiresAt}`;
  const mac = createHmac("sha256", key).update(payload).digest();
  const b64url = mac.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${userId}.${expiresAt}.${b64url}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signUnsubscribeToken", () => {
  it("produces a v1-prefixed token", () => {
    const token = signUnsubscribeToken("user-abc");
    expect(token.startsWith("v1.")).toBe(true);
  });

  it("token contains 4 dot-separated segments", () => {
    const token = signUnsubscribeToken("user-abc");
    expect(token.split(".").length).toBe(4);
  });
});

describe("verifyUnsubscribeToken — valid v1 token", () => {
  it("returns the userId for a freshly-signed token", () => {
    const token = signUnsubscribeToken("user-roundtrip");
    const result = verifyUnsubscribeToken(token);
    expect(result).toBe("user-roundtrip");
  });
});

describe("verifyUnsubscribeToken — stale key (v1 token, wrong HMAC)", () => {
  it("returns STALE_KEY when HMAC verification fails on a versioned token", () => {
    // Sign with a different key than the test key (0x42 * 32)
    const rotatedKey = Buffer.alloc(32, 0x99);
    const token = signWithKey("user-stale", rotatedKey);
    const result = verifyUnsubscribeToken(token);
    expect(result).toBe("STALE_KEY");
  });
});

describe("verifyUnsubscribeToken — malformed token", () => {
  it("returns null for completely garbled input", () => {
    expect(verifyUnsubscribeToken("notavalidtoken")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
  });

  it("returns null for a token with wrong segment count", () => {
    expect(verifyUnsubscribeToken("v1.onlythreeparts.here")).toBeNull();
  });
});

describe("verifyUnsubscribeToken — expired token", () => {
  it("returns null for a token with expiresAt in the past", () => {
    const token = signUnsubscribeToken("user-expired", -1000); // already expired
    const result = verifyUnsubscribeToken(token);
    expect(result).toBeNull();
  });
});

describe("verifyUnsubscribeToken — legacy 3-part token", () => {
  it("resolves userId for a valid legacy token signed with the current key", () => {
    const token = signLegacyWithTestKey("user-legacy");
    const result = verifyUnsubscribeToken(token);
    expect(result).toBe("user-legacy");
  });
});
