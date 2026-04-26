#!/usr/bin/env bun
/**
 * telemetry-flush.ts — Read the local telemetry buffer and POST to the
 * maintainer's collection endpoint.
 *
 * Usage:
 *   bun run scripts/telemetry-flush.ts          # manual flush
 *   (also called from session-end hook and hourly background task)
 *
 * Endpoint: ASHLR_TELEMETRY_URL env (default: https://telemetry.ashlr.ai/v1/events)
 *
 * POST shape:
 *   { sessionId: <hashed-string>, events: TelemetryRecord[] }
 *
 * Response shape (2xx):
 *   { accepted: number }
 *
 * On success: truncate buffer to entries newer than the flush horizon.
 * On error: leave buffer untouched, log to stderr (best-effort), retry next cycle.
 *
 * Privacy: only anonymized, bucketed event shapes are sent. No file paths,
 * no patterns, no content. See docs/telemetry.md for the full contract.
 *
 * Design rules:
 *   - Never throws from main(). All errors are swallowed.
 *   - Never blocks tool functionality.
 *   - 10s network timeout to prevent indefinite hangs.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  isTelemetryEnabled,
  readTelemetryBuffer,
  truncateTelemetryBuffer,
  getOrCreateTelemetrySessionId,
  looksLikePath,
  type TelemetryRecord,
} from "../servers/_telemetry";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://telemetry.ashlr.ai/v1/events";
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_EVENTS_PER_FLUSH = 500; // avoid huge payloads

function home(): string {
  return process.env.HOME ?? homedir();
}

function endpoint(): string {
  return (process.env.ASHLR_TELEMETRY_URL ?? DEFAULT_ENDPOINT).trim();
}

// ---------------------------------------------------------------------------
// Safety guard: strip any record with path-like strings before sending
// ---------------------------------------------------------------------------

function isSafeRecord(r: TelemetryRecord): boolean {
  for (const v of Object.values(r)) {
    if (typeof v === "string" && looksLikePath(v)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

interface FlushResult {
  skipped?: string;
  sent?: number;
  error?: string;
  ok: boolean;
}

export async function flush(homeDir: string = home()): Promise<FlushResult> {
  if (!isTelemetryEnabled(homeDir)) {
    return { ok: true, skipped: "telemetry-off" };
  }

  const records = readTelemetryBuffer(homeDir);
  if (records.length === 0) {
    return { ok: true, skipped: "empty-buffer" };
  }

  // Batch: take the oldest MAX_EVENTS_PER_FLUSH records.
  const batch = records.slice(0, MAX_EVENTS_PER_FLUSH).filter(isSafeRecord);
  if (batch.length === 0) {
    return { ok: true, skipped: "no-safe-records" };
  }

  // Flush horizon: the max ts in this batch. After a successful POST we drop
  // everything <= this horizon so re-flush never double-counts.
  const horizonTs = Math.max(...batch.map((r) => r.ts));

  const sessionId = getOrCreateTelemetrySessionId(homeDir);

  const body = JSON.stringify({ sessionId, events: batch });

  // 10-second timeout via AbortController.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      // Success: prune flushed entries from buffer.
      truncateTelemetryBuffer(horizonTs, homeDir);
      return { ok: true, sent: batch.length };
    } else {
      // Non-2xx: leave buffer alone, log, retry next cycle.
      return {
        ok: false,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const result = await flush();
  if (result.skipped) {
    process.stderr.write(`[ashlr-telemetry] flush skipped: ${result.skipped}\n`);
    return;
  }
  if (result.ok) {
    process.stderr.write(`[ashlr-telemetry] flushed ${result.sent ?? 0} events\n`);
  } else {
    // Silent drop on error — never surface to the user.
    process.stderr.write(`[ashlr-telemetry] flush failed (will retry): ${result.error ?? "unknown"}\n`);
  }
}

if (import.meta.main) {
  await main().catch(() => {
    // Final safety net — main() itself should never throw, but just in case.
    process.exit(0);
  });
  process.exit(0);
}
