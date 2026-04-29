#!/usr/bin/env bun
/**
 * stats-cloud-pull.ts — Pull aggregated cross-machine stats from the ashlr
 * Pro backend (GET /stats/aggregate) and cache them locally for 1 hour.
 *
 * Cache shape stored at ~/.ashlr/stats-aggregate-cache.json:
 *   {
 *     fetchedAt: ISO,
 *     data: {
 *       user_id: string,
 *       lifetime_calls: number,
 *       lifetime_tokens_saved: number,
 *       by_tool: Record<string,number>,
 *       by_day: Record<string,number>,
 *       machine_count?: number,
 *     }
 *   }
 *
 * Auth: Bearer <pro-token> in the Authorization header.
 * TTL: 1 hour — subsequent calls within the window return from cache.
 * Best-effort: never throws, never blocks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { resolveProToken } from "./stats-cloud-sync.ts";

// ---------------------------------------------------------------------------
// Paths + types
// ---------------------------------------------------------------------------

function ashlrDir(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".ashlr");
}

export function cachePath(): string {
  return join(ashlrDir(), "stats-aggregate-cache.json");
}

export interface AggregateData {
  user_id: string;
  lifetime_calls: number;
  lifetime_tokens_saved: number;
  by_tool: Record<string, number>;
  by_day: Record<string, number>;
  /** Number of distinct machines that have uploaded stats. Optional — backend may omit. */
  machine_count?: number;
}

export interface AggregateCache {
  fetchedAt: string;
  data: AggregateData;
}

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

export function readCache(): AggregateCache | null {
  try {
    const raw = readFileSync(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AggregateCache>;
    if (
      typeof parsed.fetchedAt === "string" &&
      parsed.data &&
      typeof parsed.data === "object"
    ) {
      return parsed as AggregateCache;
    }
  } catch {
    /* missing or corrupt */
  }
  return null;
}

export function isCacheValid(cache: AggregateCache | null): boolean {
  if (!cache) return false;
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  return age >= 0 && age < CACHE_TTL_MS;
}

function writeCache(data: AggregateData): void {
  try {
    mkdirSync(ashlrDir(), { recursive: true });
    const payload: AggregateCache = {
      fetchedAt: new Date().toISOString(),
      data,
    };
    writeFileSync(cachePath(), JSON.stringify(payload));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Pull logic — exported so tests can call it directly
// ---------------------------------------------------------------------------

export interface PullResult {
  skipped: boolean;
  reason?: string;
  fromCache?: boolean;
  data?: AggregateData;
  status?: number;
  error?: string;
}

export async function pullAggregateStats(opts: {
  apiUrl?: string;
  proToken?: string;
  /** Override cache TTL check — used in tests to force a re-fetch. */
  ignoreCache?: boolean;
}): Promise<PullResult> {
  const token = opts.proToken ?? resolveProToken();
  if (!token) return { skipped: true, reason: "no-pro-token" };

  const apiUrl = opts.apiUrl ?? process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";

  // Serve from cache when still fresh.
  const cache = readCache();
  if (!opts.ignoreCache && isCacheValid(cache)) {
    return { skipped: false, fromCache: true, data: cache!.data };
  }

  try {
    const res = await fetch(`${apiUrl}/stats/aggregate`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return {
        skipped: false,
        fromCache: false,
        status: res.status,
        error: `http-${res.status}`,
        // Return stale cache when available so the dashboard still shows data.
        data: cache?.data,
      };
    }

    const json = await res.json() as AggregateData;
    writeCache(json);
    return { skipped: false, fromCache: false, status: res.status, data: json };
  } catch (e) {
    return {
      skipped: false,
      fromCache: false,
      error: e instanceof Error ? e.message : "network-error",
      // Return stale cache on network error.
      data: cache?.data,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience: read cache synchronously for dashboard rendering
// ---------------------------------------------------------------------------

/**
 * Returns the cached aggregate data if present and Pro token exists.
 * Does NOT trigger a network pull (call pullAggregateStats for that).
 * Used by the dashboard to render the cross-machine line without blocking.
 */
export function readAggregateCache(): AggregateData | null {
  if (!resolveProToken()) return null;
  const cache = readCache();
  return cache?.data ?? null;
}

// ---------------------------------------------------------------------------
// Fire-and-forget entry point — called from session hooks
// ---------------------------------------------------------------------------

/**
 * Best-effort pull of cross-machine aggregate. Gated on Pro token. 1h cache.
 * Never throws, never blocks.
 */
export function maybeCloudPull(): void {
  const token = resolveProToken();
  if (!token) return;

  // Serve from cache when still fresh.
  const cache = readCache();
  if (isCacheValid(cache)) return;

  // Detach — never await this
  void pullAggregateStats({ proToken: token });
}

if (import.meta.main) {
  const result = await pullAggregateStats({ ignoreCache: true });
  if (result.skipped) {
    process.stderr.write(`[ashlr:stats-pull] skipped (${result.reason})\n`);
  } else if (result.error) {
    process.stderr.write(`[ashlr:stats-pull] error: ${result.error}\n`);
  } else {
    const d = result.data!;
    process.stdout.write(
      `lifetime_tokens_saved: ${d.lifetime_tokens_saved}\n` +
      `lifetime_calls:        ${d.lifetime_calls}\n` +
      (d.machine_count != null ? `machines:              ${d.machine_count}\n` : ""),
    );
  }
  process.exit(0);
}
