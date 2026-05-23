/**
 * _prefetch — Predictive prefetch MVP (Q3 supporting pillar).
 *
 * When ashlr__read succeeds on file X, we schedule a fire-and-forget
 * background task that:
 *   1. Scans X's import statements via lightweight regex (NOT AST) to
 *      identify neighbour files.
 *   2. Picks the top-N most-imported neighbours (deduped, frequency-ranked).
 *   3. Reads each, runs snipCompact, and stores the result in the existing
 *      _read-cache so the next ashlr__read on any of them is instant.
 *
 * Tier gates (enforced at top of schedulePrefetch):
 *   - free  → return immediately, no work.
 *   - pro   → maxNeighbors clamped to 3.
 *   - team  → maxNeighbors clamped to 10.
 *
 * Kill switch:
 *   - ASHLR_PREFETCH=off → return immediately regardless of tier.
 *
 * Constraints:
 *   - NEVER blocks the calling read path. Fire-and-forget via setImmediate.
 *   - Hard 1.5s wallclock cap; remaining neighbours skipped after the cap.
 *   - cwd-clamped: never reads outside the project root.
 *   - Idempotent: re-prefetching a path that's already cached is a no-op.
 *   - No external deps. Pure stdlib + bun built-ins.
 */

import { readFile, stat } from "fs/promises";
import { existsSync, statSync } from "fs";
import { dirname, isAbsolute, resolve, sep } from "path";
import {
  type Message,
  snipCompact,
} from "@ashlr/core-efficiency";
import { getCached, setCached } from "./_read-cache";
import { clampToCwd } from "./_cwd-clamp";
import { logEvent } from "./_events";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wallclock cap for the entire background prefetch task. */
const HARD_BUDGET_MS = 1500;

/** Extensions tried when resolving a relative import without explicit extension. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".h", ".hpp"];

/** Directories never followed for import resolution. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrefetchTier = "free" | "pro" | "team";

export interface PrefetchOptions {
  tier: PrefetchTier;
  /** Caller hint; will be clamped per tier. */
  maxNeighbors: number;
  /** Project cwd — used as the resolution + clamp root. */
  cwd: string;
}

interface InflightTracker {
  /** Paths currently being prefetched (so duplicate schedules become no-ops). */
  inflight: Set<string>;
}

const tracker: InflightTracker = { inflight: new Set() };

// ---------------------------------------------------------------------------
// Tier gating
// ---------------------------------------------------------------------------

/** Resolve the per-tier neighbor cap. Free → 0 (disabled). */
export function tierCap(tier: PrefetchTier): number {
  if (tier === "free") return 0;
  if (tier === "pro") return 3;
  if (tier === "team") return 10;
  return 0;
}

/** ASHLR_PREFETCH kill switch — "off" disables all prefetch work. */
export function isPrefetchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["ASHLR_PREFETCH"];
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Lightweight regex import extraction. Covers:
 *   - TS/JS  ES imports: `import X from 'Y'`, `import { X } from 'Y'`
 *   - TS/JS  `from 'Y'` bare matches (catches re-exports)
 *   - CommonJS `require('Y')`
 *   - Python `from X import` and `import X`
 *   - C/C++ `#include "X"` / `#include <X>`
 *
 * Returns frequency-ranked unique specifiers. Multiple matches of the same
 * specifier are counted once per occurrence (so a file imported twice ranks
 * higher than a file imported once) but the returned list is deduped.
 */
export function extractImports(source: string): string[] {
  const patterns: RegExp[] = [
    /import\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
    /from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Python: `from X import …` / `import X[.Y]`
    /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm,
    /^\s*import\s+([A-Za-z_][\w.]*)/gm,
    // C/C++ includes
    /#include\s+["<]([^">]+)[">]/g,
  ];

  const counts = new Map<string, number>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (!spec) continue;
      counts.set(spec, (counts.get(spec) ?? 0) + 1);
    }
  }

  // Highest count first; stable secondary by first-seen order.
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([spec]) => spec);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an import specifier to an absolute file path inside `cwd`, or null.
 *
 * Strategy (best-effort, no full resolver):
 *   - Skip bare specifiers (no leading "./" / "../" / "/") — those are
 *     usually node_modules or stdlib, which we don't want to prefetch.
 *   - Resolve relative paths against `fromFile`'s directory.
 *   - Try the path as-is; then with each RESOLVE_EXTENSIONS suffix; then
 *     as `path/index.<ext>`.
 *   - Refuse anything under SKIP_DIRS.
 *   - Final cwd-clamp guards against `../../../etc/passwd` escapes.
 */
export function resolveImport(
  spec: string,
  fromFile: string,
  cwd: string,
): string | null {
  // Bare specifier (npm pkg / stdlib) — skip; we only prefetch first-party files.
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    // Python dotted module — try as a relative-from-cwd path lookup.
    if (/^[A-Za-z_][\w.]*$/.test(spec)) {
      const candidatePy = resolve(cwd, spec.replace(/\./g, sep) + ".py");
      if (existsSync(candidatePy)) return candidatePy;
    }
    return null;
  }

  const base = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);

  const candidates: string[] = [base];
  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(base + ext);
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(resolve(base, "index" + ext));
  }

  for (const c of candidates) {
    if (containsSkipDir(c)) continue;
    try {
      const st = statSync(c);
      if (st.isFile()) {
        // Clamp to project cwd as the security boundary.
        const clamp = clampToCwd(c, "ashlr__prefetch");
        if (!clamp.ok) return null;
        return clamp.abs;
      }
    } catch {
      // not this candidate; continue
    }
  }
  return null;
}

function containsSkipDir(p: string): boolean {
  const parts = p.split(sep);
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Test hook: optional override for readFile so tests can simulate slow I/O.
 * Production code never sets this.
 */
let _readImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf-8");
export function _setReadImplForTest(fn: ((p: string) => Promise<string>) | null): void {
  _readImpl = fn ?? ((p) => readFile(p, "utf-8"));
}

/**
 * Test hook: drains the inflight set. Tests should call this in afterEach to
 * isolate idempotency assertions.
 */
export function _resetInflightForTest(): void {
  tracker.inflight.clear();
}

/**
 * Schedule a fire-and-forget prefetch starting from `path`.
 *
 * IMPORTANT: This function MUST NOT be awaited by the calling read path.
 * It returns immediately; all real work is deferred via setImmediate.
 *
 * Returns a Promise<PrefetchResult> for test instrumentation only; production
 * callers should ignore the return value.
 */
export interface PrefetchResult {
  scheduled: number;
  completed: number;
  durationMs: number;
  skipped: "kill-switch" | "free-tier" | "idempotent" | "stat-failed" | null;
}

export function schedulePrefetch(
  path: string,
  opts: PrefetchOptions,
): Promise<PrefetchResult> {
  // Kill switch — highest priority, before any work.
  if (isPrefetchDisabled()) {
    return Promise.resolve({ scheduled: 0, completed: 0, durationMs: 0, skipped: "kill-switch" });
  }

  // Tier gate — free tier does nothing.
  const cap = Math.min(opts.maxNeighbors, tierCap(opts.tier));
  if (cap <= 0) {
    return Promise.resolve({ scheduled: 0, completed: 0, durationMs: 0, skipped: "free-tier" });
  }

  // Idempotency: already scheduled for this path → no-op.
  if (tracker.inflight.has(path)) {
    return Promise.resolve({ scheduled: 0, completed: 0, durationMs: 0, skipped: "idempotent" });
  }
  tracker.inflight.add(path);

  // Defer all real work to the next tick so the caller's read response goes
  // out first. The returned promise resolves when the background task finishes
  // (or when the 1.5s budget elapses).
  return new Promise<PrefetchResult>((resolvePromise) => {
    setImmediate(() => {
      const started = Date.now();
      runPrefetch(path, cap, opts, started)
        .then((res) => {
          tracker.inflight.delete(path);
          resolvePromise(res);
        })
        .catch(() => {
          // Never propagate — prefetch is best-effort.
          tracker.inflight.delete(path);
          resolvePromise({
            scheduled: 0,
            completed: 0,
            durationMs: Date.now() - started,
            skipped: null,
          });
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runPrefetch(
  path: string,
  cap: number,
  opts: PrefetchOptions,
  started: number,
): Promise<PrefetchResult> {
  const remainingMs = () => HARD_BUDGET_MS - (Date.now() - started);

  // Read the source file (sync stat first to skip non-files cheaply).
  let stMtime = 0;
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      return { scheduled: 0, completed: 0, durationMs: Date.now() - started, skipped: "stat-failed" };
    }
    stMtime = st.mtimeMs;
  } catch {
    return { scheduled: 0, completed: 0, durationMs: Date.now() - started, skipped: "stat-failed" };
  }
  void stMtime;

  if (remainingMs() <= 0) {
    return { scheduled: 0, completed: 0, durationMs: Date.now() - started, skipped: null };
  }

  let source: string;
  try {
    source = await _readImpl(path);
  } catch {
    return { scheduled: 0, completed: 0, durationMs: Date.now() - started, skipped: null };
  }

  // Extract & resolve neighbours.
  const specs = extractImports(source);
  const neighbours: string[] = [];
  for (const spec of specs) {
    if (neighbours.length >= cap) break;
    const abs = resolveImport(spec, path, opts.cwd);
    if (!abs) continue;
    if (abs === path) continue; // self-import
    if (neighbours.includes(abs)) continue;
    neighbours.push(abs);
  }

  // Fire telemetry: scheduled count up front so we observe it even if the
  // budget cuts work short.
  void logEvent("tool_call", {
    tool: "ashlr__prefetch",
    reason: "prefetch_scheduled",
    extra: {
      neighbors_scheduled: neighbours.length,
      tier: opts.tier,
      cap,
    },
  });

  let completed = 0;
  for (const neighbour of neighbours) {
    if (remainingMs() <= 0) break;

    // Already cached + fresh? Skip — idempotent at the neighbour level.
    try {
      const st = statSync(neighbour);
      const hit = getCached(neighbour);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        continue;
      }

      // Race the read against the remaining budget.
      const content = await raceWithBudget(_readImpl(neighbour), remainingMs());
      if (content == null) break;

      // Apply snipCompact via the same Message wrapper read-server uses.
      const msgs: Message[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "ashlr-prefetch", content },
          ],
        },
      ];
      const compact = snipCompact(msgs);
      const block = (compact[0]!.content as { type: string; content: string }[])[0]!;
      const compactText = (block as { content: string }).content;

      setCached(neighbour, {
        mtimeMs: st.mtimeMs,
        result: `(prefetched)\n${compactText}`,
        sourceBytes: content.length,
      });
      completed++;
    } catch {
      // Skip this neighbour silently — best-effort.
      continue;
    }
  }

  const durationMs = Date.now() - started;
  void logEvent("tool_call", {
    tool: "ashlr__prefetch",
    reason: "prefetch_hit",
    extra: {
      neighbors_scheduled: neighbours.length,
      neighbors_completed: completed,
      duration_ms: durationMs,
      tier: opts.tier,
      budget_exhausted: remainingMs() <= 0,
    },
  });

  return { scheduled: neighbours.length, completed, durationMs, skipped: null };
}

/**
 * Race a promise against the remaining wallclock budget. Returns null on
 * timeout. Used to enforce the 1.5s hard cap when a single neighbour read
 * stalls (e.g., slow disk, network FS).
 */
function raceWithBudget<T>(p: Promise<T>, budgetMs: number): Promise<T | null> {
  if (budgetMs <= 0) return Promise.resolve(null);
  return new Promise<T | null>((resolveRace) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolveRace(null);
      }
    }, budgetMs);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolveRace(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolveRace(null);
        }
      },
    );
  });
}
