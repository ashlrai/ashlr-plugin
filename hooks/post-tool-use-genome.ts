#!/usr/bin/env bun
/**
 * post-tool-use-genome.ts — Cross-platform replacement for post-tool-use-genome.sh.
 *
 * Streams the PostToolUse JSON payload into scripts/genome-auto-propose.ts,
 * which decides whether to append a proposal to the nearest .ashlrcode/genome/
 * proposals.jsonl. Fire-and-forget: must never block the agent, must never
 * emit on stdout.
 *
 * Honors:
 *   ASHLR_GENOME_AUTO=0          — env-var kill switch
 *   ~/.ashlr/config.json         — { "genomeAuto": false } disables
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { flushHookTimings, recordHookTiming } from "./pretooluse-common";

const hookStartedAt = Date.now();
let observedTool: string | undefined;
let outcome: "ok" | "error" = "ok";

async function exit(code: number): Promise<never> {
  recordHookTiming({
    hook: "post-tool-use-genome",
    tool: observedTool,
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
  await flushHookTimings();
  process.exit(code);
}

if (process.env.ASHLR_GENOME_AUTO === "0") await exit(0);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(scriptDir, "..");
const proposeTs = join(pluginRoot, "scripts", "genome-auto-propose.ts");

if (!existsSync(proposeTs)) await exit(0);

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", async () => {
  const stdin = Buffer.concat(chunks);
  try {
    const raw = stdin.toString("utf-8").trim();
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      observedTool = (p.tool_name as string | undefined) || undefined;
    }
  } catch {
    /* best-effort */
  }
  try {
    // Suppress stdout so we don't pollute the hook channel.
    const proc = Bun.spawn(["bun", "run", proposeTs], {
      stdin: new Response(stdin),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    outcome = "error";
    /* best-effort */
  }
  await exit(0);
});
