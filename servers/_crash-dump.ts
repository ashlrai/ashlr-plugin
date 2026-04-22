/**
 * Crash-dump channel — post-mortem records for handler crashes.
 *
 * When a handler in `_tool-base.ts` runStandalone catches a thrown exception,
 * it already emits a `tool_crashed` observability event. This module adds an
 * on-disk dump so maintainers can inspect the full args/stack later without
 * re-running the crashing call.
 *
 * Layout: ~/.ashlr/crashes/<YYYY-MM-DD>.jsonl (append-only JSONL, one crash
 * per line). Rotated to the last 7 days on each write.
 *
 * Contract:
 *   - Never throws — this is observability, not a critical path.
 *   - Inputs are redacted for common secret patterns before serialization.
 *   - args are truncated to 1 KB, stack to 4 KB, to bound disk growth.
 */

import { appendFile, mkdir, readdir, unlink } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_ARGS_BYTES = 1024;
const MAX_STACK_BYTES = 4096;
const KEEP_DAYS = 7;

// ---------------------------------------------------------------------------
// Path helpers — resolved lazily so tests overriding $HOME work.
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

export function crashesDir(): string {
  return join(home(), ".ashlr", "crashes");
}

function crashFilePath(date = new Date()): string {
  const key = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(crashesDir(), `${key}.jsonl`);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact common secret patterns from a string. Conservative: matches shapes
 * more than specific tokens so a leaked key in an error message doesn't land
 * unredacted on disk.
 *
 *   - Authorization: Bearer <token>
 *   - sk-… / ghp_… / gho_… / ghu_… / ghs_… / npm_… style keys
 *   - 40-char hex (legacy git tokens)
 *   - base64-ish runs ≥ 32 chars with typical key entropy markers
 *   - key=value or "key": "value" for names like token, apiKey, secret, password
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let s = input;

  // Authorization header values (Bearer / Basic)
  s = s.replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"'`]+/gi, "$1<redacted>");

  // Provider-prefixed keys
  s = s.replace(/\b(sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})\b/g, "<redacted>");

  // "token": "...", "apiKey": "...", etc. (JSON-ish)
  s = s.replace(
    /("(?:token|api[_-]?key|authorization|password|secret|cookie|session)"\s*:\s*")([^"\\]{4,})(")/gi,
    "$1<redacted>$3",
  );

  // token=... / api_key=... / password=... (querystring / env-style)
  s = s.replace(
    /\b(token|api[_-]?key|authorization|password|secret)=([^\s&"']+)/gi,
    "$1=<redacted>",
  );

  // Long hex (40+ chars) — legacy tokens
  s = s.replace(/\b[a-f0-9]{40,}\b/gi, "<redacted-hex>");

  return s;
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "<max-depth>";
  if (value == null) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Redact the *value* when the key itself looks sensitive, regardless of content.
      if (/\b(token|api[_-]?key|authorization|password|secret|cookie)\b/i.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CrashDumpInput {
  tool: string;
  args: unknown;
  error: unknown;
}

export interface CrashDumpRecord {
  ts: string;
  tool: string;
  message: string;
  stack?: string;
  args: string;
  node?: string;
  bun?: string;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}

function runtimeVersions(): { node?: string; bun?: string } {
  const out: { node?: string; bun?: string } = {};
  if (typeof process.versions?.node === "string") out.node = process.versions.node;
  // Bun exposes Bun.version at runtime; guard for non-Bun envs.
  const b = (globalThis as { Bun?: { version?: string } }).Bun;
  if (b && typeof b.version === "string") out.bun = b.version;
  return out;
}

/**
 * Append a crash record to today's dump file and rotate old files.
 * Never throws.
 */
export async function writeCrashDump(input: CrashDumpInput): Promise<void> {
  try {
    const err = input.error;
    const message = err instanceof Error ? err.message : String(err);
    const rawStack = err instanceof Error && typeof err.stack === "string" ? err.stack : undefined;

    // Serialize args to JSON first so the 1KB budget is predictable; fall back
    // to a string coercion if the structure contains cycles.
    let argsStr: string;
    try {
      argsStr = JSON.stringify(redactDeep(input.args));
    } catch {
      argsStr = redactSecrets(String(input.args));
    }

    const record: CrashDumpRecord = {
      ts: new Date().toISOString(),
      tool: input.tool,
      message: redactSecrets(message),
      stack: rawStack ? truncate(redactSecrets(rawStack), MAX_STACK_BYTES) : undefined,
      args: truncate(argsStr, MAX_ARGS_BYTES),
      ...runtimeVersions(),
    };

    const path = crashFilePath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + "\n", "utf-8");

    // Rotate older files past KEEP_DAYS. Best-effort — retention failures
    // don't need to surface to the caller.
    await rotateOldFiles().catch(() => undefined);
  } catch {
    // Never propagate — post-mortem must not crash the crashed process.
  }
}

/**
 * Delete dump files older than KEEP_DAYS. Retains today + the prior 6 days.
 */
async function rotateOldFiles(): Promise<void> {
  const dir = crashesDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const today = new Date();
  // Build the set of accepted date keys for the retention window.
  const keep = new Set<string>();
  for (let i = 0; i < KEEP_DAYS; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    keep.add(d.toISOString().slice(0, 10));
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const dateKey = name.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    if (keep.has(dateKey)) continue;
    await unlink(join(dir, name)).catch(() => undefined);
  }
}
