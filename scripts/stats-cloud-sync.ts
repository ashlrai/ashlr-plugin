#!/usr/bin/env bun
/**
 * stats-cloud-sync.ts — Delta push of lifetime stats to the ashlr Pro backend.
 *
 * Reads local stats (via _stats.ts readStats()), computes the delta since the
 * last successful sync (cursor stored in ~/.ashlr/stats-sync-cursor.json), and
 * POSTs to POST /stats/sync.
 *
 * Privacy:
 *   - machineId is a one-way SHA-256 hash of os.hostname() — the raw hostname
 *     is never sent. The hash lets the backend deduplicate machine uploads
 *     without learning the hostname.
 *   - Only pure counts are sent (calls, tokensSaved, byTool, byDay). No paths,
 *     no file content, no CWD.
 *
 * Cursor shape: { syncedAt: ISO, calls: number, tokensSaved: number }
 *   - `calls` and `tokensSaved` are the lifetime totals at the time of the
 *     last successful sync. The delta is (current - cursor). We send the
 *     full current lifetime snapshot (not just the delta numbers) because the
 *     server uses upsert/idempotent semantics — re-sending the same payload is
 *     safe and avoids a separate delta endpoint.
 *
 * Best-effort: never throws, never blocks. On network failure the cursor is left
 * untouched so the next call will retry the full accumulation.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";

import { readStats } from "../servers/_stats.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function ashlrDir(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".ashlr");
}

export function cursorPath(): string {
  return join(ashlrDir(), "stats-sync-cursor.json");
}

export function proTokenPath(): string {
  return join(ashlrDir(), "pro-token");
}

// ---------------------------------------------------------------------------
// Pro-token resolution
// Priority: ASHLR_PRO_TOKEN env var → ~/.ashlr/pro-token file
// ---------------------------------------------------------------------------

export function resolveProToken(): string | null {
  const env = process.env["ASHLR_PRO_TOKEN"];
  if (env && env.trim().length > 0) return env.trim();
  try {
    const p = proTokenPath();
    if (!existsSync(p)) return null;
    const tok = readFileSync(p, "utf-8").trim();
    return tok.length > 0 ? tok : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// machineId — SHA-256 of hostname, first 16 hex chars.
// Stable per machine; one-way so the server never sees the raw hostname.
// ---------------------------------------------------------------------------

export function machineId(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

interface SyncCursor {
  syncedAt: string;
  calls: number;
  tokensSaved: number;
}

export function readCursor(): SyncCursor | null {
  try {
    const raw = readFileSync(cursorPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SyncCursor>;
    if (
      typeof parsed.syncedAt === "string" &&
      typeof parsed.calls === "number" &&
      typeof parsed.tokensSaved === "number"
    ) {
      return parsed as SyncCursor;
    }
  } catch {
    /* missing or corrupt — treat as first sync */
  }
  return null;
}

function writeCursor(cursor: SyncCursor): void {
  try {
    mkdirSync(ashlrDir(), { recursive: true });
    writeFileSync(cursorPath(), JSON.stringify(cursor));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Core push logic — exported so tests can call it directly
// ---------------------------------------------------------------------------

export interface SyncResult {
  skipped: boolean;
  reason?: string;
  ok?: boolean;
  status?: number;
  error?: string;
}

export async function pushStatsToCloud(opts: {
  apiUrl?: string;
  proToken?: string;
}): Promise<SyncResult> {
  const token = opts.proToken ?? resolveProToken();
  if (!token) return { skipped: true, reason: "no-pro-token" };
  if (process.env["ASHLR_STATS_UPLOAD"] === "0") {
    return { skipped: true, reason: "kill-switch" };
  }

  const apiUrl = opts.apiUrl ?? process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";

  let stats: Awaited<ReturnType<typeof readStats>>;
  try {
    stats = await readStats();
  } catch {
    return { skipped: false, error: "read-stats-failed" };
  }

  const cursor = readCursor();

  // Skip if nothing has changed since last sync.
  if (
    cursor &&
    cursor.calls === stats.lifetime.calls &&
    cursor.tokensSaved === stats.lifetime.tokensSaved
  ) {
    return { skipped: true, reason: "no-delta" };
  }

  // Build a pure-counts payload — byTool and byDay collapse to tokensSaved-only
  // maps to match the server's ByToolSchema / ByDaySchema.
  const byTool: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats.lifetime.byTool)) {
    byTool[k] = v.tokensSaved;
  }
  const byDay: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats.lifetime.byDay)) {
    byDay[k] = v.tokensSaved;
  }

  const body = {
    apiToken: token,
    stats: {
      lifetime: {
        calls:       stats.lifetime.calls,
        tokensSaved: stats.lifetime.tokensSaved,
        byTool,
        byDay,
      },
    },
    // machineId is informational — the server deduplicates on apiToken+machineId.
    machineId: machineId(),
  };

  try {
    const res = await fetch(`${apiUrl}/stats/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      // Persist cursor only on success. Failures leave cursor untouched → retry.
      writeCursor({
        syncedAt: new Date().toISOString(),
        calls: stats.lifetime.calls,
        tokensSaved: stats.lifetime.tokensSaved,
      });
      return { skipped: false, ok: true, status: res.status };
    }
    return { skipped: false, ok: false, status: res.status, error: `http-${res.status}` };
  } catch (e) {
    return { skipped: false, ok: false, error: e instanceof Error ? e.message : "network-error" };
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget entry point — called from session hooks
// ---------------------------------------------------------------------------

/**
 * Best-effort cloud sync. Gated on Pro token presence. Never throws, never
 * blocks the caller. Rate-limited: at most once per 5 minutes (tracked via
 * cursor syncedAt). For use at SessionEnd to flush the final stats.
 */
export function maybeCloudSync(): void {
  const token = resolveProToken();
  if (!token) return;
  if (process.env["ASHLR_STATS_UPLOAD"] === "0") return;

  // Rate-limit: if cursor is recent (< 5 min), skip.
  const cursor = readCursor();
  if (cursor) {
    const age = Date.now() - new Date(cursor.syncedAt).getTime();
    if (age < 5 * 60 * 1000) return;
  }

  // Detach — never await this
  void pushStatsToCloud({ proToken: token });
}

if (import.meta.main) {
  const result = await pushStatsToCloud({});
  if (result.skipped) {
    process.stderr.write(`[ashlr:stats-sync] skipped (${result.reason})\n`);
  } else if (result.ok) {
    process.stderr.write(`[ashlr:stats-sync] pushed ok (HTTP ${result.status})\n`);
  } else {
    process.stderr.write(`[ashlr:stats-sync] failed: ${result.error}\n`);
  }
  process.exit(0);
}
