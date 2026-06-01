/**
 * _token-measure.ts — Measured token counting via Anthropic API.
 *
 * Two modes:
 *   estimateTokens(text)  — synchronous chars/4 heuristic (always available)
 *   measureTokens(text)   — async Anthropic API call returning true input_tokens
 *
 * Design constraints:
 *   - NEVER blocks a hot path. All API calls are fire-and-forget from callers.
 *   - Returns null on missing API key, timeout, or any failure.
 *   - SHA-256 LRU cache persisted at ~/.ashlr/token-measure-cache.json (max 500).
 *   - 5s AbortSignal timeout per call.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { estimateTokensFromString } from "@ashlr/core-efficiency";

export type MeasurementMode = "estimate" | "measured";

// ---------------------------------------------------------------------------
// Estimate (synchronous, always available)
// ---------------------------------------------------------------------------

/**
 * Estimate token count using the chars/4 heuristic. Wraps the shared
 * estimateTokensFromString from @ashlr/core-efficiency for a single import
 * surface.
 */
export function estimateTokens(text: string): number {
  return estimateTokensFromString(text);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  tokens: number;
  /** ISO timestamp — used for eviction ordering */
  at: string;
}

interface CacheShape {
  /** sha256(text) → entry */
  entries: Record<string, CacheEntry>;
}

const MAX_CACHE_ENTRIES = 500;

function cachePath(): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "token-measure-cache.json");
}

function loadCache(): CacheShape {
  try {
    const p = cachePath();
    if (!existsSync(p)) return { entries: {} };
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    if (!parsed.entries || typeof parsed.entries !== "object") return { entries: {} };
    return { entries: parsed.entries };
  } catch {
    return { entries: {} };
  }
}

function saveCache(cache: CacheShape): void {
  try {
    const p = cachePath();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(cache), "utf-8");
  } catch {
    // best-effort
  }
}

function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function evictIfNeeded(cache: CacheShape): void {
  const keys = Object.keys(cache.entries);
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  // Sort by timestamp ascending, drop oldest to get under limit
  const sorted = keys.sort((a, b) => {
    const ta = cache.entries[a]?.at ?? "";
    const tb = cache.entries[b]?.at ?? "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const toRemove = sorted.slice(0, keys.length - MAX_CACHE_ENTRIES);
  for (const k of toRemove) {
    delete cache.entries[k];
  }
}

// ---------------------------------------------------------------------------
// Measure (async, requires ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

/**
 * Measure true token count via Anthropic API.
 *
 * Returns null when:
 *   - ANTHROPIC_API_KEY is not set
 *   - Request times out (5s)
 *   - Any network or API error
 *   - Response shape is unexpected
 *
 * Results are cached by SHA-256(text) to avoid redundant API calls.
 * NEVER throws — callers must be able to fire-and-forget.
 */
export async function measureTokens(text: string): Promise<number | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const key = cacheKey(text);
  const cache = loadCache();

  // Cache hit
  const cached = cache.entries[key];
  if (cached && typeof cached.tokens === "number") {
    return cached.tokens;
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      }),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as { usage?: { input_tokens?: number } };
    const tokens = json?.usage?.input_tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) return null;

    // Store in cache
    cache.entries[key] = { tokens, at: new Date().toISOString() };
    evictIfNeeded(cache);
    saveCache(cache);

    return tokens;
  } catch {
    // timeout, network error, JSON parse error — all return null
    return null;
  }
}
