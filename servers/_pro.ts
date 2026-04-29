/**
 * _pro.ts — Pro token validation with 24h cache and 7-day offline grace.
 *
 * The token stored in ~/.ashlr/pro-token is a permanent API token (not a JWT)
 * issued by POST /auth/verify on the server. Validation is done by calling
 * GET /user/me with the Bearer token — the server returns { userId, email,
 * tier, githubLogin, hasGitHub }. "Pro" status means tier === "pro" || "team".
 *
 * Cache semantics:
 *   - Validated result is written to ~/.ashlr/pro-token-cache.json.
 *   - Cache < 24h old → used directly, no network call.
 *   - Cache 24h–7d old → used immediately (offline grace), background refresh
 *     triggered via setImmediate.
 *   - Cache > 7d old → treated as expired; forces synchronous re-validation.
 *   - 401 from server → renames token to pro-token.invalid, returns invalid.
 *   - Network error → falls back to cached result if < 7 days old.
 */

import { existsSync, renameSync, statSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS      = 24 * 60 * 60 * 1000;   // 24h
const OFFLINE_GRACE_MS  = 7  * 24 * 60 * 60 * 1000; // 7d

const API_URL = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function ashlrDir(homeOverride?: string): string {
  return join(homeOverride ?? process.env.HOME ?? homedir(), ".ashlr");
}

export function proTokenPath(homeOverride?: string): string {
  return join(ashlrDir(homeOverride), "pro-token");
}

export function proTokenCachePath(homeOverride?: string): string {
  return join(ashlrDir(homeOverride), "pro-token-cache.json");
}

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

export interface ProTokenCache {
  valid: boolean;
  plan: string | null;
  trialEndsAt: string | null;
  validatedAt: string; // ISO
}

export interface ProValidationResult {
  valid: boolean;
  plan: string | null;
  trialEndsAt: string | null;
  validatedAt: string | null;
  reason?: "no-token" | "expired-or-revoked" | "network-error" | "cached";
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

async function readCache(homeOverride?: string): Promise<ProTokenCache | null> {
  const p = proTokenCachePath(homeOverride);
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as ProTokenCache;
    if (
      typeof parsed.valid === "boolean" &&
      typeof parsed.validatedAt === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cache: ProTokenCache, homeOverride?: string): Promise<void> {
  const p = proTokenCachePath(homeOverride);
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort — never block the hot path
  }
}

// ---------------------------------------------------------------------------
// Token file I/O
// ---------------------------------------------------------------------------

function readTokenSync(homeOverride?: string): string | null {
  const p = proTokenPath(homeOverride);
  try {
    const s = statSync(p);
    if (!s.isFile() || s.size === 0) return null;
    const { readFileSync } = require("fs") as typeof import("fs");
    return readFileSync(p, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function invalidateToken(homeOverride?: string): void {
  const p = proTokenPath(homeOverride);
  const dest = p + ".invalid";
  try {
    renameSync(p, dest);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Network validation
// ---------------------------------------------------------------------------

interface UserMeResponse {
  userId?: string;
  email?: string;
  tier?: string;
  githubLogin?: string | null;
  hasGitHub?: boolean;
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/**
 * Calls GET /user/me with the given token.
 * Returns null on network error (caller should fall back to cache).
 * Returns { tier } on success, or throws with status 401 when revoked.
 */
async function fetchUserMe(
  token: string,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = 5000,
): Promise<{ tier: string; trialEndsAt: string | null } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${API_URL}/user/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
    });

    if (res.status === 401) {
      throw Object.assign(new Error("401"), { status: 401 });
    }

    if (!res.ok) {
      // 5xx or unexpected — treat as network error (fallback to cache)
      return null;
    }

    let body: UserMeResponse;
    try {
      body = (await res.json()) as UserMeResponse;
    } catch {
      return null;
    }

    return {
      tier: body.tier ?? "free",
      trialEndsAt: null, // /user/me doesn't expose trial_ends_at today; extend when server does
    };
  } catch (err: unknown) {
    if (err instanceof Error && "status" in err && (err as { status: number }).status === 401) {
      throw err; // propagate 401
    }
    // Timeout or network error → caller falls back
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

function spawnBackgroundRefresh(homeOverride?: string): void {
  setImmediate(async () => {
    try {
      const token = readTokenSync(homeOverride);
      if (!token) return;
      const result = await fetchUserMe(token);
      if (!result) return;
      const isPro = result.tier === "pro" || result.tier === "team";
      await writeCache(
        {
          valid: isPro,
          plan: result.tier,
          trialEndsAt: result.trialEndsAt,
          validatedAt: new Date().toISOString(),
        },
        homeOverride,
      );
    } catch {
      // background refresh — never throw
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the Pro token in ~/.ashlr/pro-token.
 *
 * @param opts.homeOverride   Override home dir (for testing).
 * @param opts.fetchImpl      Override fetch (for testing).
 * @param opts.nowMs          Override Date.now() (for testing).
 */
export async function validateProToken(opts: {
  homeOverride?: string;
  fetchImpl?: FetchLike;
  nowMs?: number;
} = {}): Promise<ProValidationResult> {
  const { homeOverride, fetchImpl = globalThis.fetch, nowMs = Date.now() } = opts;

  // 1. Check token file
  const token = readTokenSync(homeOverride);
  if (!token) {
    return { valid: false, plan: null, trialEndsAt: null, validatedAt: null, reason: "no-token" };
  }

  // 2. Read cache
  const cached = await readCache(homeOverride);
  const cacheAge = cached ? nowMs - new Date(cached.validatedAt).getTime() : Infinity;

  // 3. Cache < 24h → use directly
  if (cached && cacheAge < CACHE_TTL_MS) {
    return {
      valid: cached.valid,
      plan: cached.plan,
      trialEndsAt: cached.trialEndsAt,
      validatedAt: cached.validatedAt,
      reason: "cached",
    };
  }

  // 4. Cache is stale (24h–7d) → return cached value, refresh in background
  if (cached && cacheAge < OFFLINE_GRACE_MS) {
    spawnBackgroundRefresh(homeOverride);
    return {
      valid: cached.valid,
      plan: cached.plan,
      trialEndsAt: cached.trialEndsAt,
      validatedAt: cached.validatedAt,
      reason: "cached",
    };
  }

  // 5. No usable cache → do a synchronous network call
  try {
    const result = await fetchUserMe(token, fetchImpl);

    if (result === null) {
      // Network error — if we have a stale cache (> 7d), still use it
      if (cached) {
        return {
          valid: cached.valid,
          plan: cached.plan,
          trialEndsAt: cached.trialEndsAt,
          validatedAt: cached.validatedAt,
          reason: "network-error",
        };
      }
      return { valid: false, plan: null, trialEndsAt: null, validatedAt: null, reason: "network-error" };
    }

    const isPro = result.tier === "pro" || result.tier === "team";
    const newCache: ProTokenCache = {
      valid: isPro,
      plan: result.tier,
      trialEndsAt: result.trialEndsAt,
      validatedAt: new Date(nowMs).toISOString(),
    };
    await writeCache(newCache, homeOverride);

    return {
      valid: isPro,
      plan: result.tier,
      trialEndsAt: result.trialEndsAt,
      validatedAt: newCache.validatedAt,
    };
  } catch (err: unknown) {
    // 401 → revoke token
    if (err instanceof Error && "status" in err && (err as { status: number }).status === 401) {
      invalidateToken(homeOverride);
      return {
        valid: false,
        plan: null,
        trialEndsAt: null,
        validatedAt: null,
        reason: "expired-or-revoked",
      };
    }

    // Unexpected error → fallback to stale cache
    if (cached) {
      return {
        valid: cached.valid,
        plan: cached.plan,
        trialEndsAt: cached.trialEndsAt,
        validatedAt: cached.validatedAt,
        reason: "network-error",
      };
    }
    return { valid: false, plan: null, trialEndsAt: null, validatedAt: null, reason: "network-error" };
  }
}

/**
 * Synchronous best-effort Pro check — reads only the cache file.
 * Returns false when no cache or cache is expired beyond 7d.
 * Suitable for hot paths where we cannot await.
 */
export function isProSync(homeOverride?: string): boolean {
  const cached = (() => {
    const p = proTokenCachePath(homeOverride);
    try {
      const { readFileSync } = require("fs") as typeof import("fs");
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw) as ProTokenCache;
    } catch {
      return null;
    }
  })();

  if (!cached) return false;
  const age = Date.now() - new Date(cached.validatedAt).getTime();
  return cached.valid && age < OFFLINE_GRACE_MS;
}
