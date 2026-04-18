#!/usr/bin/env bun
/**
 * session-end-consolidate.ts — Cross-platform replacement for session-end-consolidate.sh.
 *
 * Invoked by Claude Code on session shutdown. Hands off to
 * scripts/genome-auto-consolidate.ts which reads proposals.jsonl in the
 * current project's genome, merges them into target sections, and truncates
 * the queue.
 *
 * Best-effort: a failed consolidation must never disturb the user's session
 * exit. All output goes to stderr. Exits 0 always.
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

if (process.env.ASHLR_GENOME_AUTO === "0") process.exit(0);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(scriptDir, "..");
const consolidateTs = join(pluginRoot, "scripts", "genome-auto-consolidate.ts");

if (!existsSync(consolidateTs)) process.exit(0);

const targetDir = process.env.PROJECT_ROOT ?? process.cwd();

try {
  // Run in background so session teardown isn't delayed by filesystem latency.
  // The script is idempotent and bounded, so fire-and-forget is safe.
  Bun.spawn(["bun", "run", consolidateTs, "--dir", targetDir], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
} catch {
  /* best-effort */
}

process.exit(0);
