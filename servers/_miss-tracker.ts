/**
 * _miss-tracker.ts: compression miss tracking (self-tuning P1).
 *
 * A "miss" is a compressed ashlr__read / ashlr__grep result for a target that
 * is followed by a native Read / Grep of the same target within
 * MISS_WINDOW_TURNS turns. That re-read signals the compact output was not
 * enough. Counts feed the per-repo tuner (P2).
 *
 * Privacy: local only. Targets are kept only as an 8-char hash in the
 * per-session pending file; the persistent stats file holds counts keyed by
 * ashlr tool and file extension, never paths or content.
 *
 * Off switches: ASHLR_TUNING=off or ASHLR_SESSION_LOG=0. Best-effort, never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";

import { sha8 } from "./_history-tracker";

/** A native re-read within this many turns of a compressed result counts as a miss. */
export const MISS_WINDOW_TURNS = 3;

const ASHLR_TOOLS: Record<string, "read" | "grep"> = {
  ashlr__read: "read",
  ashlr__grep: "grep",
  "mcp__ashlr-efficiency__ashlr__read": "read",
  "mcp__ashlr-efficiency__ashlr__grep": "grep",
  mcp__plugin_ashlr_ashlr__ashlr__read: "read",
  mcp__plugin_ashlr_ashlr__ashlr__grep: "grep",
};
const NATIVE_TOOLS: Record<string, "read" | "grep"> = { Read: "read", Grep: "grep" };

export interface MissCounts { compressed: number; misses: number }
/** stats[tool]["." + ext or "(none)"] */
export type MissStats = Record<string, Record<string, MissCounts>>;

interface Pending { t: string; tool: string; ext: string; turn: number; missed?: boolean }

export function trackingEnabled(): boolean {
  return process.env.ASHLR_TUNING !== "off" && process.env.ASHLR_SESSION_LOG !== "0";
}

export function missStatsPath(homeDir: string): string {
  return join(homeDir, ".ashlr", "miss-stats.json");
}
function pendingPath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".ashlr", "miss-pending", `${sessionId}.json`);
}

function readJson<T>(p: string, fallback: T): T {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as T) : fallback; } catch { return fallback; }
}
function writeJson(p: string, v: unknown): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(v), "utf-8");
}

/** Target path from a Read/Grep or ashlr__read/ashlr__grep tool_input. */
export function targetOf(input: unknown, cwd: string = process.cwd()): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const p = i.file_path ?? i.path;
  if (typeof p !== "string" || !p.trim()) return null;
  return resolve(cwd, p);
}

export function readMissStats(homeDir: string): MissStats {
  return readJson<MissStats>(missStatsPath(homeDir), {});
}

/**
 * Observe one completed tool call. `turn` is the session turn index of this
 * call. Returns "compressed", "miss", or null (nothing recorded).
 */
export function observeToolCall(
  toolName: string,
  toolInput: unknown,
  turn: number,
  sessionId: string,
  homeDir: string,
  cwd: string = process.cwd(),
): "compressed" | "miss" | null {
  if (!trackingEnabled()) return null;
  try {
    const kind = ASHLR_TOOLS[toolName] ?? NATIVE_TOOLS[toolName];
    if (!kind) return null;
    const target = targetOf(toolInput, cwd);
    if (!target) return null;
    const t = sha8(target);
    const pp = pendingPath(homeDir, sessionId);
    const pending = readJson<Pending[]>(pp, []).filter((e) => turn - e.turn <= MISS_WINDOW_TURNS);
    const stats = readMissStats(homeDir);
    const bump = (tool: string, ext: string, key: keyof MissCounts) => {
      const row = (stats[tool] ??= {});
      const c = (row[ext] ??= { compressed: 0, misses: 0 });
      c[key]++;
    };

    let outcome: "compressed" | "miss" | null = null;
    if (ASHLR_TOOLS[toolName]) {
      const tool = `ashlr__${kind}`;
      const ext = extname(target).toLowerCase() || "(none)";
      pending.push({ t, tool, ext, turn });
      bump(tool, ext, "compressed");
      outcome = "compressed";
    } else {
      const hit = pending.find((e) => e.t === t && !e.missed && e.turn < turn);
      if (hit) {
        hit.missed = true;
        bump(hit.tool, hit.ext, "misses");
        outcome = "miss";
      }
    }
    writeJson(pp, pending);
    if (outcome) writeJson(missStatsPath(homeDir), stats);
    return outcome;
  } catch {
    return null;
  }
}
