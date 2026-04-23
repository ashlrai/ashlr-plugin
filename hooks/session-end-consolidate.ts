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
const consolidateTs = join(pluginRoot, "scripts", "genome-auto-consolidate.ts");
const pushTs        = join(pluginRoot, "scripts", "genome-cloud-push.ts");

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
}

main().finally(() => process.exit(0));
