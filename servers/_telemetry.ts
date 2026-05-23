/**
 * _telemetry.ts — Opt-in anonymized telemetry buffer + writer.
 *
 * STRICTLY OPT-IN. Default OFF. Users enable via:
 *   - ~/.ashlr/config.json ::  { "telemetry": "opt-in" }
 *   - env: ASHLR_TELEMETRY=on
 *
 * Kill switch (always respected, highest priority):
 *   - ~/.ashlr/config.json :: { "telemetry": "off" }
 *   - env: ASHLR_TELEMETRY=off
 *
 * What is collected:
 *   - Tool call shapes: tool name, raw/compact byte counts, fell-back flag,
 *     provider used, duration. No file paths, no patterns, no content.
 *   - Pre-tool-use block metadata: tool name, blocked-to destination, size bucket.
 *   - Pre-tool-use passthrough reason: tool name, bypass reason string.
 *   - Session header: plugin version, bun version, platform, arch.
 *
 * What is NEVER collected:
 *   - File paths
 *   - Grep patterns
 *   - File content or command arguments
 *   - User identifiers or repo names
 *
 * Design:
 *   - Synchronous append to ~/.ashlr/telemetry-buffer.jsonl (same pattern as
 *     _recent-blocks.ts — atomic for lines < PIPE_BUF).
 *   - Capped at MAX_BUFFER_LINES (5000). Oldest entries evicted when exceeded.
 *   - Eviction is lazy (checked on write) using atomic rename to avoid blocking
 *     the hot path most of the time.
 *   - Never throws. Never blocks tool functionality.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_BUFFER_LINES = 5000;

// Eviction is triggered when the file grows past this multiple of MAX_BUFFER_LINES.
// Using 1.1 (10% overage) keeps the file tight without frequent rewrites.
const EVICTION_FACTOR = 1.1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Size bucket for pre-tool-use block events. Never raw bytes. */
export type SizeRange = "small" | "medium" | "large";

/** Canonical telemetry event kinds. */
export type TelemetryEventKind =
  | "tool_call"
  | "pretooluse_block"
  | "pretooluse_passthrough"
  | "version"
  // "multi_turn_stale_estimate" removed in v1.30 (1.5) — wired since v1.24, never populated.
  | "hook_perf"
  | "genome_compression_ratio"
  | "wizard_step"
  | "pre_compaction_nudge_emitted";

/** tool_call payload — what the maintainer needs to tune heuristics. */
export interface ToolCallPayload {
  tool: string;
  /** The MCP tool name (e.g. "ashlr__grep"). Added in v1.30 (1.1). */
  tool_name?: string;
  rawBytes: number;
  compactBytes: number;
  fellBack: boolean;
  providerUsed: string;
  durationMs: number;
}

/** pretooluse_block payload. */
export interface PreToolUseBlockPayload {
  tool: string;
  blockedTo: string;
  sizeRange: SizeRange;
}

/** pretooluse_passthrough payload. */
export interface PreToolUsePassthroughPayload {
  tool: string;
  reason: "below-threshold" | "out-of-cwd" | "plugin-tree" | "micro-edit" | "bypass";
}

/** version / session-header payload. Sent once per session. */
export interface VersionPayload {
  pluginVersion: string;
  bunVersion: string;
  platform: string;
  arch: string;
}

/**
 * multi_turn_stale_estimate payload — removed in v1.30 (1.5).
 * Kept as a type alias for backward-compat with any call sites that may still
 * reference it; the event kind is no longer accepted by the server.
 * @deprecated
 */
export interface MultiTurnStaleEstimatePayload {
  sessionTurnCount: number;
  staleBytes: number;
  staleResults: number;
}

/**
 * pre_compaction_nudge_emitted payload — fired once per session when cumulative
 * context bytes approach the auto-compact threshold (~80K tokens).
 */
export interface PreCompactionNudgePayload {
  cumulativeBytes: number;
  estimatedTokens: number;
  pct: number;
}

/**
 * hook_perf payload — one rollup per hook name per session, emitted at SessionEnd.
 * p50_ms / p99_ms derived from hook-timings.jsonl. Added in v1.30 (1.2).
 */
export interface HookPerfPayload {
  hook_name: string;
  p50_ms: number;
  p99_ms: number;
  count: number;
}

/**
 * genome_compression_ratio payload — emitted on every ashlr__grep call that
 * routes through the genome path. Added in v1.30 (1.3).
 */
export interface GenomeCompressionRatioPayload {
  tool: string;
  raw_bytes: number;
  compressed_bytes: number;
}

/**
 * wizard_step payload — emitted by Track 3 (Wizard Repair) for each wizard step.
 * Schema added here so Track 3 emit sites just work. Added in v1.30 (Track 3 coord).
 */
export interface WizardStepPayload {
  step_name: string;
  outcome: "completed" | "skipped" | "error";
}

/** Union of all typed payloads. */
export type TelemetryPayload =
  | ({ kind: "tool_call" } & ToolCallPayload)
  | ({ kind: "pretooluse_block" } & PreToolUseBlockPayload)
  | ({ kind: "pretooluse_passthrough" } & PreToolUsePassthroughPayload)
  | ({ kind: "version" } & VersionPayload)
  | ({ kind: "hook_perf" } & HookPerfPayload)
  | ({ kind: "genome_compression_ratio" } & GenomeCompressionRatioPayload)
  | ({ kind: "wizard_step" } & WizardStepPayload)
  | ({ kind: "pre_compaction_nudge_emitted" } & PreCompactionNudgePayload);

/** A single JSONL record in the buffer. */
export interface TelemetryRecord {
  ts: number;
  kind: TelemetryEventKind;
  sessionId: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Path helpers (resolved at call-time so tests overriding $HOME work)
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

export function telemetryBufferPath(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "telemetry-buffer.jsonl");
}

export function telemetrySessionPath(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "telemetry-session.json");
}

export function ashlrConfigPath(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "config.json");
}

// ---------------------------------------------------------------------------
// Config reading (shared with session-start.ts — local copy to avoid
// circular imports across the servers/ and hooks/ boundary)
// ---------------------------------------------------------------------------

function readConfig(homeDir: string = home()): Record<string, unknown> {
  try {
    const p = ashlrConfigPath(homeDir);
    if (!fsExistsSync(p)) return {};
    const raw = fsReadFileSync(p, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* treat as empty */
  }
  return {};
}

// ---------------------------------------------------------------------------
// Opt-in check
// ---------------------------------------------------------------------------

/**
 * Returns true only when the user has explicitly opted in via:
 *   ASHLR_TELEMETRY=on  OR  config.telemetry === "opt-in"
 *
 * Any other value (missing, "off", anything else) → false (opt-out / default).
 */
export function isTelemetryEnabled(homeDir: string = home()): boolean {
  // Env kill switch takes highest priority.
  const envVal = (process.env.ASHLR_TELEMETRY ?? "").toLowerCase().trim();
  if (envVal === "off" || envVal === "0") return false;
  if (envVal === "on" || envVal === "1") {
    // Env opt-in: verify config doesn't explicitly say "off".
    const config = readConfig(homeDir);
    if (config.telemetry === "off") return false;
    return true;
  }

  // No env override: check config file.
  const config = readConfig(homeDir);
  return config.telemetry === "opt-in";
}

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

/**
 * Returns the per-session hashed ID. Creates one if it doesn't exist.
 * The session file is written on first call and deleted by the session-end hook.
 *
 * We use a UUID-like random string hashed via a simple XOR fold so the raw
 * random seed never persists — only the folded hex is stored.
 */
export function getOrCreateTelemetrySessionId(homeDir: string = home()): string {
  const sessionPath = telemetrySessionPath(homeDir);
  try {
    if (fsExistsSync(sessionPath)) {
      const raw = JSON.parse(fsReadFileSync(sessionPath, "utf-8")) as { id?: unknown };
      if (typeof raw.id === "string" && raw.id.length > 0) return raw.id;
    }
  } catch {
    /* fall through to create */
  }

  // Create a new session ID: random seed → simple hash → hex string.
  const seed = `${Date.now()}:${Math.random().toString(36)}:${Math.random().toString(36)}`;
  const id = hashString(seed);

  try {
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({ id, createdAt: Date.now() }), "utf-8");
  } catch {
    /* best-effort */
  }

  return id;
}

/**
 * Delete the session file on session end.
 */
export function deleteTelemetrySession(homeDir: string = home()): void {
  try {
    const sessionPath = telemetrySessionPath(homeDir);
    if (fsExistsSync(sessionPath)) {
      // Use fs.unlinkSync — keep the import footprint minimal.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { unlinkSync } = require("fs") as typeof import("fs");
      unlinkSync(sessionPath);
    }
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Simple string hash (non-crypto — for session-id generation only)
// ---------------------------------------------------------------------------

function hashString(s: string): string {
  // djb2 XOR variant — good enough for a non-security opaque identifier.
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ c;
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0"));
}

// ---------------------------------------------------------------------------
// Buffer writer
// ---------------------------------------------------------------------------

/**
 * Record one telemetry event to the local buffer.
 *
 * Called from event-emission sites (alongside logEvent) when telemetry is
 * enabled. Must be cheap: synchronous append-only.
 *
 * Race safety: appendFileSync is atomic for writes < PIPE_BUF (~512B–4KB on
 * POSIX, ~4KB on Windows). Our JSONL lines are ≤400B, well inside the
 * threshold. Concurrent callers cannot interleave bytes.
 *
 * Eviction: when the buffer exceeds MAX_BUFFER_LINES * EVICTION_FACTOR, we
 * do a one-shot atomic rewrite dropping oldest entries. This only runs on
 * the write path that pushes us over the limit — typically rare.
 */
export function recordTelemetryEvent(
  payload: TelemetryPayload,
  homeDir: string = home(),
): void {
  if (!isTelemetryEnabled(homeDir)) return;

  try {
    const bufPath = telemetryBufferPath(homeDir);
    mkdirSync(dirname(bufPath), { recursive: true });

    const sessionId = getOrCreateTelemetrySessionId(homeDir);

    // Build the anonymized record. Destructure `kind` out; spread remaining.
    const { kind, ...rest } = payload;

    // Safety guard: reject any record that sneaks in a path-like string value.
    // This is a regression guardrail — callers should never pass paths, but
    // we double-check here as defense in depth.
    for (const v of Object.values(rest)) {
      if (typeof v === "string" && looksLikePath(v)) {
        // Drop the event silently rather than risk exfiltrating a path.
        return;
      }
    }

    const record: TelemetryRecord = {
      ts: Math.floor(Date.now() / 1000), // epoch seconds (not ms) to save bytes
      kind,
      sessionId,
      ...rest,
    };

    const line = JSON.stringify(record) + "\n";
    appendFileSync(bufPath, line, "utf-8");

    // Lazy eviction: check line count and prune if needed.
    // We do this AFTER the append so the new event isn't lost.
    _maybeEvict(bufPath);
  } catch {
    // Never propagate — telemetry must never break tool functionality.
  }
}

/**
 * Convenience wrapper for posttooluse-stale-result — records a
 * pre_compaction_nudge_emitted event when context is approaching auto-compact.
 * No-op when telemetry is off.
 */
export function logPreCompactionNudgeEvent(
  payload: PreCompactionNudgePayload,
  homeDir: string = home(),
): void {
  recordTelemetryEvent({ kind: "pre_compaction_nudge_emitted", ...payload }, homeDir);
}

/**
 * Record a hook_perf rollup event. Called from the session-end hook after
 * reading hook-timings.jsonl and computing per-hook percentiles.
 * No-op when telemetry is off.
 */
export function logHookPerfEvent(
  payload: HookPerfPayload,
  homeDir: string = home(),
): void {
  recordTelemetryEvent({ kind: "hook_perf", ...payload }, homeDir);
}

/**
 * Record a genome_compression_ratio event. Called from ashlr__grep whenever
 * the genome path returns content.
 * No-op when telemetry is off.
 */
export function logGenomeCompressionRatioEvent(
  payload: GenomeCompressionRatioPayload,
  homeDir: string = home(),
): void {
  recordTelemetryEvent({ kind: "genome_compression_ratio", ...payload }, homeDir);
}

/**
 * Returns true if `s` looks like an absolute filesystem path.
 * Used as a safety guard to prevent accidental path exfiltration.
 */
export function looksLikePath(s: string): boolean {
  if (s.length < 3) return false;
  // POSIX absolute: starts with /
  if (s.startsWith("/")) return true;
  // Windows absolute: C:\ or \\server\share
  if (/^[A-Za-z]:[/\\]/.test(s)) return true;
  if (s.startsWith("\\\\")) return true;
  return false;
}

/**
 * Evict oldest entries when the buffer exceeds MAX_BUFFER_LINES * EVICTION_FACTOR.
 * Uses atomic rename (write to .tmp, then rename) so concurrent readers see
 * either the old or new file, never a partial write.
 *
 * Only called from recordTelemetryEvent — never on the hot read path.
 */
function _maybeEvict(bufPath: string): void {
  try {
    if (!existsSync(bufPath)) return;
    const raw = readFileSync(bufPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length <= Math.floor(MAX_BUFFER_LINES * EVICTION_FACTOR)) return;

    // Keep only the most recent MAX_BUFFER_LINES entries.
    const pruned = lines.slice(-MAX_BUFFER_LINES);
    _atomicRewrite(bufPath, pruned);
  } catch {
    /* best-effort */
  }
}

function _atomicRewrite(path: string, lines: string[]): void {
  const tmp = path + ".tmp";
  const content = lines.length === 0 ? "" : lines.join("\n") + "\n";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Consent notice stamp (testable without importing the full session-start hook)
// ---------------------------------------------------------------------------

/** Path to the one-time consent notice stamp. */
export function telemetryConsentStampPath(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "telemetry-consent-shown");
}

/**
 * Returns a one-liner consent notice the first time telemetry is enabled,
 * then null on all subsequent calls (stamp-gated).
 *
 * Strictly opt-in: returns null immediately when telemetry is off.
 */
export function maybeTelemetryConsentNotice(homeDir: string = home()): string | null {
  if (!isTelemetryEnabled(homeDir)) return null;
  const stampPath = telemetryConsentStampPath(homeDir);
  try {
    if (existsSync(stampPath)) return null;
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, new Date().toISOString(), "utf-8");
  } catch {
    /* best-effort — never break the hook */
  }
  return (
    "[ashlr] Telemetry opt-in active. Collecting anonymized tool-shape metrics " +
    "(no paths, no content). To disable: set ASHLR_TELEMETRY=off or " +
    '~/.ashlr/config.json { "telemetry": "off" }. See docs/telemetry.md.\n'
  );
}

// ---------------------------------------------------------------------------
// Buffer reader (used by the flusher)
// ---------------------------------------------------------------------------

/**
 * Read all records from the buffer. Returns empty array on any error.
 */
export function readTelemetryBuffer(homeDir: string = home()): TelemetryRecord[] {
  try {
    const bufPath = telemetryBufferPath(homeDir);
    if (!existsSync(bufPath)) return [];
    const raw = readFileSync(bufPath, "utf-8");
    const records: TelemetryRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as TelemetryRecord);
      } catch {
        /* skip malformed lines */
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Truncate the buffer to only entries newer than `horizonTs` (epoch seconds).
 * Called by the flusher after a successful POST.
 */
export function truncateTelemetryBuffer(
  horizonTs: number,
  homeDir: string = home(),
): void {
  try {
    const bufPath = telemetryBufferPath(homeDir);
    const records = readTelemetryBuffer(homeDir);
    const kept = records.filter((r) => r.ts > horizonTs);
    _atomicRewrite(bufPath, kept.map((r) => JSON.stringify(r)));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// WAD-D daily heartbeat (added for the weekly-active-developers metric)
// ---------------------------------------------------------------------------

/**
 * Payload posted to /stats/daily-active. Only salted-hashes + UTC date +
 * plugin version — no PII, no raw machine_id, no raw github login.
 */
export interface DailyHeartbeatPayload {
  /** sha256(machine_id + quarterly_salt). 64 hex chars. */
  machineHash: string;
  /** sha256(github_login + quarterly_salt) when signed-in Pro/Team; else null. */
  githubHash: string | null;
  /** UTC date the heartbeat is for: "YYYY-MM-DD". */
  date: string;
  /** ashlr-plugin semver (from package.json). */
  pluginVersion: string;
}

/**
 * Optional override of the daily-heartbeat endpoint URL. Tests inject this
 * so they don't hit the real api.ashlr.ai. Module-private — exported only
 * via the test hook below.
 */
let _heartbeatUrlOverride: string | null = null;
let _heartbeatFetchOverride: typeof fetch | null = null;
let _heartbeatLastEmittedDate: string | null = null;

/** Test hook: force the heartbeat to POST to a mock URL. */
export function _setDailyHeartbeatUrl(url: string | null): void {
  _heartbeatUrlOverride = url;
}

/** Test hook: inject a custom fetch (e.g. to assert calls). */
export function _setDailyHeartbeatFetch(fn: typeof fetch | null): void {
  _heartbeatFetchOverride = fn;
}

/** Test hook: reset the in-process last-emitted memo. */
export function _resetDailyHeartbeatMemo(): void {
  _heartbeatLastEmittedDate = null;
}

/**
 * Resolve the daily-active endpoint URL. Match the existing cloud-sync
 * pattern (ASHLR_API_URL env override → https://api.ashlr.ai default), but
 * routed to /stats/daily-active.
 *
 * TODO: backend implementation pending — the route is wired client-side
 * before the server-side handler exists. Free-tier clients silently fail
 * the POST until the route lands.
 */
function dailyHeartbeatUrl(): string {
  if (_heartbeatUrlOverride) return _heartbeatUrlOverride;
  const base = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
  return `${base.replace(/\/+$/, "")}/stats/daily-active`;
}

/**
 * Fire-and-forget POST of the daily heartbeat. Gated on telemetry consent.
 *
 * Guarantees:
 *   - Returns immediately (does NOT await the network call).
 *   - Silent on every error path — never breaks the recordSaving hot path.
 *   - No-op when telemetry consent is "off"/missing.
 *   - In-process idempotent for the (date, machineHash) tuple — a second
 *     call for the same UTC date from the same process is a no-op even if
 *     the stats.json daily_active gate ever races.
 */
export function emitDailyHeartbeat(
  payload: DailyHeartbeatPayload,
  homeDir: string = home(),
): void {
  try {
    if (!isTelemetryEnabled(homeDir)) return;
    if (_heartbeatLastEmittedDate === payload.date) return;
    _heartbeatLastEmittedDate = payload.date;

    const url = dailyHeartbeatUrl();
    const fetcher = _heartbeatFetchOverride ?? globalThis.fetch;

    // Fire-and-forget — never await, never throw.
    void Promise.resolve()
      .then(() =>
        fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identity_hash: payload.machineHash,
            github_hash: payload.githubHash,
            date: payload.date,
            plugin_version: payload.pluginVersion,
          }),
          signal: AbortSignal.timeout(10_000),
        }),
      )
      .catch(() => {
        /* network failure — drop silently */
      });
  } catch {
    /* never propagate */
  }
}
