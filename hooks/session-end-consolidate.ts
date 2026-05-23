#!/usr/bin/env bun
/**
 * session-end-consolidate.ts — Cross-platform replacement for session-end-consolidate.sh.
 *
 * Invoked by Claude Code on session shutdown. Two responsibilities:
 *   1. Consolidate — hand off to scripts/genome-auto-consolidate.ts which
 *      reads proposals.jsonl in the current project's genome, merges them
 *      into target sections, and truncates the queue.
 *   2. Push (v1.17 T2.5, opt-in) — after consolidation, fire
 *      scripts/genome-cloud-push.ts so teammates pulling on SessionStart see
 *      this session's merged state. No-op when the repo has no
 *      .ashlrcode/genome/.cloud-id.
 *
 * Best-effort: a failed consolidation or push must never disturb the user's
 * session exit. All output goes to stderr. Exits 0 always.
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

if (process.env.ASHLR_GENOME_AUTO === "0") process.exit(0);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(scriptDir, "..");
const consolidateTs    = join(pluginRoot, "scripts", "genome-auto-consolidate.ts");
const pushTs           = join(pluginRoot, "scripts", "genome-cloud-push.ts");
const telemetryFlushTs = join(pluginRoot, "scripts", "telemetry-flush.ts");
const sessionEventEmitTs = join(pluginRoot, "scripts", "session-event-emit.ts");
const refreshTs        = join(pluginRoot, "scripts", "genome-refresh-worker.ts");
const hookPerfEmitTs   = join(pluginRoot, "hooks", "_hook-perf-emit.ts");
const hookHealthNudgeTs = join(pluginRoot, "hooks", "sessionend-hook-health-nudge.ts");
const statusLineNudgeTs = join(pluginRoot, "hooks", "sessionend-status-line-nudge.ts");

if (!existsSync(consolidateTs)) process.exit(0);

const targetDir = process.env.PROJECT_ROOT ?? process.cwd();

// Consolidation bound to 10s — generous for local fs; prevents a pathological
// consolidate from stalling session shutdown. Push is opt-in and bounded
// separately by its own network timeout.
const CONSOLIDATE_BUDGET_MS = 10_000;
const POST_HOOK_BUDGET_MS   = 15_000;

const deadline = Date.now() + POST_HOOK_BUDGET_MS;

async function awaitWithBudget(
  proc: { exited: Promise<number> },
  budgetMs: number,
): Promise<"ok" | "timeout"> {
  let to: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolveP) => {
    to = setTimeout(() => resolveP("timeout"), budgetMs);
  });
  const done = proc.exited.then(() => "ok" as const);
  const result = await Promise.race([done, timeout]);
  if (to) clearTimeout(to);
  return result;
}

async function main(): Promise<void> {
  // 1. Consolidate. Await so the push path below sees the merged state.
  try {
    const proc = Bun.spawn(["bun", "run", consolidateTs, "--dir", targetDir], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    await awaitWithBudget(proc, CONSOLIDATE_BUDGET_MS);
  } catch {
    /* best-effort */
  }

  // 2. Push — only if the push script exists (older plugin versions don't
  // ship it) and we still have budget. Fire-and-forget; network latency
  // doesn't block shutdown.
  if (existsSync(pushTs) && Date.now() < deadline) {
    try {
      Bun.spawn(["bun", "run", pushTs, "--quiet", "--cwd", targetDir], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch {
      /* best-effort */
    }
  }

  // 3. Genome incremental refresh — process pending edits accumulated during
  // the session. Fire-and-forget with a 10s budget; a slow refresh never
  // blocks session exit. Uses --quiet so no output pollutes the hook channel.
  if (existsSync(refreshTs) && Date.now() < deadline) {
    try {
      Bun.spawn(["bun", "run", refreshTs, "--quiet"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch {
      /* best-effort — refresh never blocks shutdown */
    }
  }

  // 4. Hook-perf telemetry rollup (opt-in). Reads hook-timings.jsonl, computes
  // p50/p99 per hook, and writes hook_perf events to the telemetry buffer.
  // Fire-and-forget; runs before the flush so events are captured in this batch.
  if (existsSync(hookPerfEmitTs) && Date.now() < deadline) {
    try {
      Bun.spawn(["bun", "run", hookPerfEmitTs], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch {
      /* best-effort — hook perf telemetry never blocks shutdown */
    }
  }

  // 5. Hook health nudges (errors + regression). Bounded by a 1.5s budget
  // and runs awaitably so its stdout reaches the SessionEnd channel before
  // shutdown. Tail-bounded reads keep this well under the 2s hook safety net.
  if (existsSync(hookHealthNudgeTs) && Date.now() < deadline) {
    try {
      const proc = Bun.spawn(["bun", "run", hookHealthNudgeTs], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "pipe",
      });
      await awaitWithBudget(proc, 1_500);
    } catch {
      /* best-effort — hook health nudges never block shutdown */
    }
  }

  // 6. Status-line discovery nudge — one-shot per user. Bounded by a
  // 1s budget and runs awaitably so stdout reaches the SessionEnd channel
  // before shutdown. Tiny JSON reads only; never touches jsonls.
  if (existsSync(statusLineNudgeTs) && Date.now() < deadline) {
    try {
      const proc = Bun.spawn(["bun", "run", statusLineNudgeTs], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "pipe",
      });
      await awaitWithBudget(proc, 1_000);
    } catch {
      /* best-effort — status-line discovery nudge never blocks shutdown */
    }
  }

  // 7. Telemetry flush (opt-in, no-op when telemetry is off). Fire-and-forget;
  // network errors are silently dropped by the flush script itself. We spawn
  // rather than import so a crash in the flush script never affects shutdown.
  if (existsSync(telemetryFlushTs) && Date.now() < deadline) {
    try {
      Bun.spawn(["bun", "run", telemetryFlushTs], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch {
      /* best-effort — telemetry never blocks shutdown */
    }
  }

  // 8. Q4 session-event emit. Last step in the chain.
  // Posts ONE structured event per session (tool counts, savings totals,
  // discovery refs, branch SHA) to /v1/session-events. Honors the same
  // opt-in telemetry consent gate as the telemetry buffer flush above.
  //
  // Awaited against a 500ms budget so SessionEnd never exceeds the 2s
  // hook safety net (v1.29) even when the network is slow — the script
  // also enforces its own AbortSignal.timeout(500) internally.
  if (existsSync(sessionEventEmitTs) && Date.now() < deadline) {
    try {
      const proc = Bun.spawn(["bun", "run", sessionEventEmitTs, "--dir", targetDir], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      await awaitWithBudget(proc, 500);
    } catch {
      /* best-effort — session-event emit never blocks shutdown */
    }
  }
}

main().finally(() => process.exit(0));
