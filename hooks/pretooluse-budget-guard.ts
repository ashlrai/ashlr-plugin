#!/usr/bin/env bun
/**
 * pretooluse-budget-guard.ts — Block tool calls when the session budget is exceeded.
 *
 * PreToolUse hook. Reads ASHLR_SESSION_BUDGET_USD or ASHLR_SESSION_BUDGET_TOKENS,
 * estimates cumulative session spend from ~/.ashlr/session-log.jsonl, then:
 *   - warns at 80%  (exits 0 with additionalContext nudge, event: budget_threshold_80)
 *   - warns at 95%  (exits 0 with louder nudge, event: budget_threshold_95)
 *   - blocks at 100% (exits 2 with stderr message, event: budget_exceeded)
 *
 * Cost heuristic: tokens ≈ (input_bytes + output_bytes) / 4
 *   USD ≈ tokens / 1_000_000 * 12  (blended $4/Mtok input + $20/Mtok output, 60/40 mix)
 *
 * Design:
 *   - Best-effort only — never throws. Falls through on any read error.
 *   - Kill switch: ASHLR_SESSION_LOG=0 skips log reads (no usage data → never blocks).
 *   - Only fires when ASHLR_SESSION_BUDGET_USD or ASHLR_SESSION_BUDGET_TOKENS is set.
 *
 * Hook contract (PreToolUse):
 *   stdin  → { tool_name, tool_input? }
 *   stdout → { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext? } }
 *   exit 0 → allow
 *   exit 2 → block (message on stderr shown to user)
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Blended price per million tokens (input $4 + output $20, 60/40 mix). */
const BLENDED_USD_PER_MTOK = 4 * 0.6 + 20 * 0.4; // 9.2 $/Mtok

/** Bytes per token heuristic. */
const BYTES_PER_TOKEN = 4;

const WARN_80_PCT = 0.80;
const WARN_95_PCT = 0.95;
const BLOCK_100_PCT = 1.00;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext?: string;
  };
}

interface SessionLogEntry {
  session?: string;
  input_size?: number;
  output_size?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passThrough(context?: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(context ? { additionalContext: context } : {}),
    },
  };
}

function home(): string {
  return (
    process.env.ASHLR_HOME_OVERRIDE?.trim() ||
    process.env.HOME ||
    homedir()
  );
}

function sessionLogPath(homeDir: string): string {
  return join(homeDir, ".ashlr", "session-log.jsonl");
}

/** Derive current session ID using the same strategy as session-log-append.ts */
function currentSessionId(): string {
  const explicit =
    process.env.CLAUDE_SESSION_ID?.trim() ||
    process.env.ASHLR_SESSION_ID?.trim();
  if (explicit) return explicit;
  const seed = `${process.cwd()}:${process.ppid ?? process.pid}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(16)}`;
}

/** Read session-log.jsonl and sum input_size + output_size for the current session. */
export function readSessionBytes(homeDir: string, sessionId: string): number {
  try {
    const p = sessionLogPath(homeDir);
    if (!existsSync(p)) return 0;
    const raw = readFileSync(p, "utf-8");
    let total = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as SessionLogEntry;
        if (entry.session && entry.session !== sessionId) continue;
        total += (entry.input_size ?? 0) + (entry.output_size ?? 0);
      } catch {
        // skip malformed lines
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Bytes → estimated tokens. */
export function bytesToTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** Tokens → estimated USD. */
export function tokensToUsd(tokens: number): number {
  return (tokens / 1_000_000) * BLENDED_USD_PER_MTOK;
}

// ---------------------------------------------------------------------------
// Nudge event emission (fire-and-forget, no import from servers/ to avoid
// circular deps in a hook context)
// ---------------------------------------------------------------------------

type BudgetEventKind =
  | "budget_threshold_80"
  | "budget_threshold_95"
  | "budget_exceeded";

function emitBudgetEvent(event: BudgetEventKind, pct: number): void {
  try {
    const p = join(home(), ".ashlr", "nudge-events.jsonl");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pct: Math.round(pct * 1000) / 10,
    });
    try {
      const { appendFileSync, mkdirSync } = require("fs");
      const { dirname } = require("path");
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, line + "\n", "utf-8");
    } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Core decision (exported for tests)
// ---------------------------------------------------------------------------

export interface DecideOpts {
  home?: string;
  sessionId?: string;
  /** Override env reads for testing. */
  budgetUsd?: string;
  budgetTokens?: string;
  sessionLog?: string; // 0 = disabled
}

export interface DecideResult {
  action: "pass" | "warn-80" | "warn-95" | "block";
  context?: string;
  pct: number;
  usedTokens: number;
  budgetTokens: number;
  usedUsd: number;
  budgetUsd: number;
}

export function decide(opts: DecideOpts = {}): DecideResult {
  const sessionLogDisabled =
    (opts.sessionLog ?? process.env.ASHLR_SESSION_LOG) === "0";

  const rawUsd = opts.budgetUsd ?? process.env.ASHLR_SESSION_BUDGET_USD;
  const rawTokens = opts.budgetTokens ?? process.env.ASHLR_SESSION_BUDGET_TOKENS;

  // No budget set → always pass.
  if (!rawUsd && !rawTokens) {
    return { action: "pass", pct: 0, usedTokens: 0, budgetTokens: 0, usedUsd: 0, budgetUsd: 0 };
  }

  // No session log data → pass (can't enforce without data).
  if (sessionLogDisabled) {
    return { action: "pass", pct: 0, usedTokens: 0, budgetTokens: 0, usedUsd: 0, budgetUsd: 0 };
  }

  const homeDir = opts.home ?? home();
  const sessionId = opts.sessionId ?? currentSessionId();
  const totalBytes = readSessionBytes(homeDir, sessionId);
  const usedTokens = bytesToTokens(totalBytes);
  const usedUsd = tokensToUsd(usedTokens);

  let pct = 0;
  let budgetTokensVal = 0;
  let budgetUsdVal = 0;

  if (rawUsd) {
    budgetUsdVal = parseFloat(rawUsd);
    if (!Number.isFinite(budgetUsdVal) || budgetUsdVal <= 0) {
      return { action: "pass", pct: 0, usedTokens, budgetTokens: 0, usedUsd, budgetUsd: 0 };
    }
    pct = usedUsd / budgetUsdVal;
    budgetTokensVal = Math.ceil((budgetUsdVal / BLENDED_USD_PER_MTOK) * 1_000_000);
  } else if (rawTokens) {
    budgetTokensVal = parseInt(rawTokens, 10);
    if (!Number.isFinite(budgetTokensVal) || budgetTokensVal <= 0) {
      return { action: "pass", pct: 0, usedTokens, budgetTokens: 0, usedUsd, budgetUsd: 0 };
    }
    pct = usedTokens / budgetTokensVal;
    budgetUsdVal = tokensToUsd(budgetTokensVal);
  }

  const base = { usedTokens, budgetTokens: budgetTokensVal, usedUsd, budgetUsd: budgetUsdVal };

  if (pct >= BLOCK_100_PCT) {
    const msg = rawUsd
      ? `[ashlr] Budget exceeded — $${usedUsd.toFixed(2)} of $${budgetUsdVal.toFixed(2)} used. Run /ashlr-budget off to clear.`
      : `[ashlr] Budget exceeded — ${usedTokens.toLocaleString()} of ${budgetTokensVal.toLocaleString()} tokens used. Run /ashlr-budget off to clear.`;
    emitBudgetEvent("budget_exceeded", pct);
    return { action: "block", context: msg, pct, ...base };
  }

  if (pct >= WARN_95_PCT) {
    const pctStr = Math.round(pct * 100);
    const msg = rawUsd
      ? `[ashlr] Budget at ${pctStr}% — $${usedUsd.toFixed(2)} of $${budgetUsdVal.toFixed(2)} used. Consider stopping soon.`
      : `[ashlr] Budget at ${pctStr}% — ${usedTokens.toLocaleString()} of ${budgetTokensVal.toLocaleString()} tokens used. Consider stopping soon.`;
    emitBudgetEvent("budget_threshold_95", pct);
    return { action: "warn-95", context: msg, pct, ...base };
  }

  if (pct >= WARN_80_PCT) {
    const pctStr = Math.round(pct * 100);
    const msg = rawUsd
      ? `[ashlr] Budget at ${pctStr}% — $${usedUsd.toFixed(2)} of $${budgetUsdVal.toFixed(2)} used.`
      : `[ashlr] Budget at ${pctStr}% — ${usedTokens.toLocaleString()} of ${budgetTokensVal.toLocaleString()} tokens used.`;
    emitBudgetEvent("budget_threshold_80", pct);
    return { action: "warn-80", context: msg, pct, ...base };
  }

  return { action: "pass", pct, ...base };
}

// ---------------------------------------------------------------------------
// Stdin reading
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read stdin (required by hook contract) but we only need the tool name.
  try {
    await readStdin();
  } catch {
    // stdin read failure → pass through
  }

  let result: DecideResult;
  try {
    result = decide();
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
    process.exit(0);
  }

  if (result!.action === "block") {
    process.stderr.write(result!.context ?? "[ashlr] Budget exceeded.");
    process.exit(2);
  }

  const context = result!.action !== "pass" ? result!.context : undefined;
  process.stdout.write(JSON.stringify(passThrough(context)));
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
