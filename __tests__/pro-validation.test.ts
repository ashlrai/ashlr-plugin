/**
 * __tests__/pro-validation.test.ts
 *
 * Hermetic tests for servers/_pro.ts — validateProToken().
 * All FS and network calls are injected via opts; no real files are touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

import { validateProToken, isProSync, proTokenPath, proTokenCachePath } from "../servers/_pro";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHome(): string {
  return join(tmpdir(), "ashlr-test-" + randomBytes(6).toString("hex"));
}

async function setupHome(home: string): Promise<void> {
  await mkdir(join(home, ".ashlr"), { recursive: true });
}

async function writeToken(home: string, token: string): Promise<void> {
  await writeFile(proTokenPath(home), token, { mode: 0o600 });
}

async function writeCache(
  home: string,
  cache: {
    valid: boolean;
    plan: string | null;
    trialEndsAt: string | null;
    validatedAt: string;
  },
): Promise<void> {
  await writeFile(proTokenCachePath(home), JSON.stringify(cache), { mode: 0o600 });
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/** Fake fetch that returns 200 with a given tier. */
function okFetch(tier: string): FetchLike {
  return async (_input, _init) => {
    return new Response(
      JSON.stringify({ userId: "u1", email: "test@example.com", tier }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

/** Fake fetch that returns 401. */
function unauthorizedFetch(): FetchLike {
  return async (_input, _init) => {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Fake fetch that throws (network error). */
function networkErrorFetch(): FetchLike {
  return async (_input, _init) => {
    throw new Error("fetch failed: connection refused");
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateProToken", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    await setupHome(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // ── 1. No token file ────────────────────────────────────────────────────────

  it("returns { valid: false, reason: no-token } when token file is absent", async () => {
    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: okFetch("pro"),
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no-token");
    expect(result.plan).toBeNull();
  });

  // ── 2. Token + 200 response ─────────────────────────────────────────────────

  it("returns { valid: true, plan } and writes cache on 200", async () => {
    await writeToken(home, "tok_abc123");

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: okFetch("pro"),
    });

    expect(result.valid).toBe(true);
    expect(result.plan).toBe("pro");
    expect(result.validatedAt).not.toBeNull();

    // Cache should be on disk
    const { readFileSync } = await import("fs");
    const raw = readFileSync(proTokenCachePath(home), "utf-8");
    const cache = JSON.parse(raw);
    expect(cache.valid).toBe(true);
    expect(cache.plan).toBe("pro");
    expect(typeof cache.validatedAt).toBe("string");
  });

  it("returns { valid: true } for team tier", async () => {
    await writeToken(home, "tok_team");

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: okFetch("team"),
    });

    expect(result.valid).toBe(true);
    expect(result.plan).toBe("team");
  });

  it("returns { valid: false } for free tier on 200", async () => {
    await writeToken(home, "tok_free");

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: okFetch("free"),
    });

    expect(result.valid).toBe(false);
    expect(result.plan).toBe("free");
  });

  // ── 3. Token + 401 ──────────────────────────────────────────────────────────

  it("renames token to .invalid and returns { valid: false, reason: expired-or-revoked } on 401", async () => {
    await writeToken(home, "tok_revoked");

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: unauthorizedFetch(),
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired-or-revoked");

    // Token file should be gone; .invalid should exist
    const { existsSync } = await import("fs");
    expect(existsSync(proTokenPath(home))).toBe(false);
    expect(existsSync(proTokenPath(home) + ".invalid")).toBe(true);
  });

  // ── 4. Cache < 24h → no network call ────────────────────────────────────────

  it("uses cache directly when validatedAt < 24h ago — no fetch call", async () => {
    await writeToken(home, "tok_cached");
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    await writeCache(home, {
      valid: true,
      plan: "pro",
      trialEndsAt: null,
      validatedAt: recentTime,
    });

    let fetchCalled = false;
    const trackingFetch: FetchLike = async (...args) => {
      fetchCalled = true;
      return okFetch("pro")(...args);
    };

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: trackingFetch,
    });

    expect(fetchCalled).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.plan).toBe("pro");
    expect(result.reason).toBe("cached");
  });

  // ── 5. Cache > 24h but < 7d + network offline ────────────────────────────────

  it("falls back to stale cache (24h–7d) on network error and returns cached value", async () => {
    await writeToken(home, "tok_stale");
    const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2d ago
    await writeCache(home, {
      valid: true,
      plan: "pro",
      trialEndsAt: null,
      validatedAt: staleTime,
    });

    // 2 days is within the 24h–7d "stale but valid" window → background refresh,
    // not synchronous re-validate. Result should use cached value.
    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: networkErrorFetch(),
      nowMs: Date.now(),
    });

    expect(result.valid).toBe(true);
    expect(result.plan).toBe("pro");
    expect(result.reason).toBe("cached");
  });

  it("re-validates synchronously when cache is older than 7 days and falls back on network error", async () => {
    await writeToken(home, "tok_ancient");
    const ancientTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8d ago
    await writeCache(home, {
      valid: true,
      plan: "pro",
      trialEndsAt: null,
      validatedAt: ancientTime,
    });

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: networkErrorFetch(),
    });

    // Falls back to stale cache because that's the best we have
    expect(result.reason).toBe("network-error");
    expect(result.valid).toBe(true); // still returns cached true
  });

  // ── 6. Fresh validate after >7d cache with valid network ─────────────────────

  it("re-validates and updates cache when cache > 7d old and network is available", async () => {
    await writeToken(home, "tok_refresh");
    const ancientTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeCache(home, {
      valid: true,
      plan: "team",
      trialEndsAt: null,
      validatedAt: ancientTime,
    });

    const result = await validateProToken({
      homeOverride: home,
      fetchImpl: okFetch("pro"), // tier changed server-side
    });

    expect(result.valid).toBe(true);
    expect(result.plan).toBe("pro"); // fresh value from network
  });
});

// ---------------------------------------------------------------------------
// isProSync
// ---------------------------------------------------------------------------

describe("isProSync", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    await setupHome(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns false when no cache file exists", () => {
    expect(isProSync(home)).toBe(false);
  });

  it("returns true when cache is valid and < 7d old", async () => {
    await writeCache(home, {
      valid: true,
      plan: "pro",
      trialEndsAt: null,
      validatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });
    expect(isProSync(home)).toBe(true);
  });

  it("returns false when cache is valid=false", async () => {
    await writeCache(home, {
      valid: false,
      plan: "free",
      trialEndsAt: null,
      validatedAt: new Date().toISOString(),
    });
    expect(isProSync(home)).toBe(false);
  });

  it("returns false when cache is > 7d old", async () => {
    await writeCache(home, {
      valid: true,
      plan: "pro",
      trialEndsAt: null,
      validatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isProSync(home)).toBe(false);
  });
});
