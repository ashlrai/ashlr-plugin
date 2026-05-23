#!/usr/bin/env bun
/**
 * session-event-emit.ts — Q4 session graph capture.
 *
 * Last step in the SessionEnd hook chain. Emits ONE structured event per
 * session to the backend's /v1/session-events endpoint, capturing the
 * session's SHAPE (tool counts, savings totals, discovery refs touched,
 * branch SHA) — WITHOUT the transcript or any raw identifier.
 *
 * Privacy:
 *   - identity_hash: stable sha256 from _identity-hash.ts (machine_id +
 *     quarterly_salt). Never reversible to a user, email, machine, or path.
 *   - github_hash:   same shape, optional. Lets the deferred session-graph
 *     UI collapse one developer across machines into one node.
 *   - session_id_hash: sha256 of CLAUDE_SESSION_ID (or ppid-derived fallback).
 *     The server never sees the raw session id.
 *   - branch_sha: first 12 chars of `git rev-parse HEAD` — best-effort,
 *     undefined when not in a git repo. Combined with identity_hash this
 *     tells us "this developer's branch was X" but not which repo. The user
 *     has opted into telemetry to enable any of this.
 *   - discovery_refs: opaque section IDs the session touched (from
 *     .ashlrcode/genome/sections/discoveries/*.json). Local-only IDs;
 *     never paths or content.
 *
 * Safety:
 *   - Gated on isTelemetryEnabled() — opt-in by default OFF.
 *   - Fire-and-forget POST with a 500ms total budget. Never blocks
 *     SessionEnd; matches the 2s safety net set in v1.29.
 *   - Never throws. Network failure, missing helpers, malformed disk state
 *     — all swallowed.
 *
 * Usage: invoked by hooks/session-end-consolidate.ts via Bun.spawn.
 *   bun run scripts/session-event-emit.ts [--dir <project>]
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { join } from "path";

import { isTelemetryEnabled } from "../servers/_telemetry";
import { getIdentityHash } from "../servers/_identity-hash";
import { readStats, candidateSessionIds } from "../servers/_stats";

// ---------------------------------------------------------------------------
// Endpoint resolver — mirrors _telemetry.ts daily-heartbeat pattern.
// ---------------------------------------------------------------------------

function sessionEventsUrl(): string {
  // Allow tests to override.
  const override = process.env["ASHLR_SESSION_EVENTS_URL"];
  if (override && override.length > 0) return override;
  const base = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
  return `${base.replace(/\/+$/, "")}/v1/session-events`;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** sha256-hex of a string. Lowercase, 64 chars. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Resolve the local raw session identifier. Prefers CLAUDE_SESSION_ID;
 * falls back to a ppid-derived seed so the value is stable across the
 * session even when the env var is absent. We never SEND this raw — only
 * its sha256.
 */
export function resolveRawSessionId(): string {
  const explicit = process.env["CLAUDE_SESSION_ID"];
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  // PPID-derived fallback. Same shape as _stats.ts ppidSessionId(), kept
  // local so we don't introduce a circular import surface.
  return `ppid:${typeof process.ppid === "number" ? process.ppid : "?"}:${process.env["HOME"] ?? ""}`;
}

/**
 * Resolve the first 12 chars of git HEAD for the project dir. Returns
 * undefined when not a git repo, git is missing, or the command times out.
 * Best-effort; never throws.
 */
export function resolveBranchSha(projectDir: string): string | undefined {
  try {
    const out = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 250, // generous; the call is local
      encoding: "utf-8",
    });
    if (out.status !== 0) return undefined;
    const sha = (out.stdout ?? "").trim();
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) return undefined;
    return sha;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate discovery section IDs the session touched. Best-effort.
 *
 * MVP scope: we can't yet track precisely which discoveries were *touched*
 * this session, so we conservatively emit an empty array. A future
 * iteration will wire this to the genome-scribe hook's per-session log.
 * The schema accepts an empty array, so the deferred aggregator stays
 * forward-compatible.
 *
 * The function still inspects .ashlrcode/genome/sections/discoveries/ so
 * a future change can read recently-modified files without changing the
 * call signature.
 */
export function collectDiscoveryRefs(projectDir: string): string[] {
  const refs: string[] = [];
  try {
    const dir = join(projectDir, ".ashlrcode", "genome", "sections", "discoveries");
    if (!existsSync(dir)) return refs;
    // Reading the directory is cheap. We don't ship the file content —
    // only the section IDs (derived from filenames) the session touched.
    // For the MVP we emit an empty list (privacy + scope), but the
    // directory walk lives here so future iterations only need to add the
    // ID extraction.
    void readdirSync(dir);
    return refs;
  } catch {
    return refs;
  }
}

/** Resolve the plugin's semver from package.json one dir up from scripts/. */
export function resolvePluginVersion(): string {
  try {
    // We're at scripts/session-event-emit.ts → package.json one level up.
    const path = join(import.meta.dir, "..", "package.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

// ---------------------------------------------------------------------------
// Payload assembly + emit
// ---------------------------------------------------------------------------

export interface SessionEventPayload {
  identity_hash: string;
  github_hash: string | null;
  session_id_hash: string;
  ended_at: string;
  tool_count: number;
  tokens_saved: number;
  branch_sha?: string;
  discovery_refs: string[];
  plugin_version: string;
}

/**
 * Build the POST payload for this session. Pulls tool_count + tokens_saved
 * from the candidate session buckets in stats.json (we sum across all
 * candidates because CLAUDE_SESSION_ID forwarding is inconsistent — see
 * _stats.ts candidateSessionIds() for the long-form explanation).
 *
 * Returns null when telemetry consent is off, since callers should skip
 * the network call entirely.
 */
export async function buildPayload(projectDir: string): Promise<SessionEventPayload | null> {
  if (!isTelemetryEnabled()) return null;

  const id = getIdentityHash();
  const rawSession = resolveRawSessionId();
  const sessionHash = sha256Hex(rawSession);

  let toolCount = 0;
  let tokensSaved = 0;
  try {
    const stats = await readStats();
    const ids = candidateSessionIds();
    for (const sid of ids) {
      const bucket = stats.sessions?.[sid];
      if (!bucket) continue;
      toolCount += bucket.calls;
      tokensSaved += bucket.tokensSaved;
    }
  } catch {
    /* best-effort — emit shape with zeros */
  }

  const branchSha = resolveBranchSha(projectDir);
  const discoveryRefs = collectDiscoveryRefs(projectDir);

  const payload: SessionEventPayload = {
    identity_hash: id.machineHash,
    github_hash: id.githubHash,
    session_id_hash: sessionHash,
    ended_at: new Date().toISOString(),
    tool_count: toolCount,
    tokens_saved: tokensSaved,
    discovery_refs: discoveryRefs,
    plugin_version: resolvePluginVersion(),
  };
  if (branchSha) payload.branch_sha = branchSha;
  return payload;
}

/**
 * Fire-and-forget POST. Returns the in-flight promise so callers can race
 * it against a 500ms budget; never awaits internally.
 *
 * Caller is expected to use Promise.race against a timeout — we don't
 * enforce one here because hook-mode emit composes the budget across
 * multiple steps in session-end-consolidate.ts.
 */
export function emitFireAndForget(payload: SessionEventPayload): Promise<void> {
  return Promise.resolve().then(async () => {
    try {
      await fetch(sessionEventsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(500),
      });
    } catch {
      /* silent — privacy + safety: never disturb session exit */
    }
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    const dirIdx = process.argv.indexOf("--dir");
    const projectDir =
      dirIdx >= 0 && process.argv[dirIdx + 1]
        ? process.argv[dirIdx + 1]!
        : process.cwd();

    const payload = await buildPayload(projectDir);
    if (!payload) return; // consent off

    // Honor the 500ms budget enforced by the SessionEnd hook chain.
    const inFlight = emitFireAndForget(payload);
    let to: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      to = setTimeout(resolve, 500);
    });
    await Promise.race([inFlight, timeout]);
    if (to) clearTimeout(to);
  } catch {
    /* swallow — never block session exit */
  }
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.main) {
  main().finally(() => process.exit(0));
}
