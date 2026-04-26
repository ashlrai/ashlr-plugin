#!/usr/bin/env bun
/**
 * posttooluse-correlate.ts — Correlate ashlr__* calls with prior native-tool
 * blocks to measure redirect conversion.
 *
 * PostToolUse hook. When an ashlr__read / ashlr__grep / ashlr__edit /
 * ashlr__multi_edit call completes, this hook reads the recent-blocks log
 * written by the pretooluse-* hooks. For every block within the 10-second
 * window, it emits a `tool_called_after_block` event with correlation metadata
 * and then prunes the consumed entries from the log.
 *
 * Design:
 *   - Best-effort only. Any error → silent continue, exit 0.
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables all telemetry.
 *   - Window: 10 seconds (configurable via ASHLR_BLOCK_WINDOW_MS).
 *   - Only fires for tools that are known ashlr equivalents.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { flushHookTimings, recordHookTiming } from "./pretooluse-common";
import { readRecentBlocks, pruneOldBlocks } from "./_recent-blocks";

const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "error" = "ok"): Promise<never> {
  recordHookTiming({
    hook: "posttooluse-correlate",
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
  await flushHookTimings();
  process.exit(code);
}

// Kill switch
if (process.env.ASHLR_SESSION_LOG === "0") await exit(0);

// Correlation window (default 10s)
const WINDOW_MS = (() => {
  const raw = process.env.ASHLR_BLOCK_WINDOW_MS;
  if (!raw) return 10_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
})();

// Map from ashlr tool → native tool it replaces (for correlation)
const ASHLR_TO_NATIVE: Record<string, string[]> = {
  "ashlr__read":       ["Read"],
  "ashlr__grep":       ["Grep"],
  "ashlr__edit":       ["Edit", "Write"],
  "ashlr__multi_edit": ["MultiEdit"],
  // Wave-1 tools (Track B/C) — reference them but they may not exist yet.
  "ashlr__websearch":  ["WebSearch"],
  "ashlr__notebook_edit": ["NotebookEdit"],
  "ashlr__write":      ["Write"],
};

// Read stdin
const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", async () => {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  } catch {
    await exit(0);
  }

  const toolName = payload.tool_name as string | undefined;
  if (!toolName) await exit(0);
  // After the guard above, toolName is narrowed to string within the
  // same block — but TypeScript can't narrow across the async exit(0)
  // boundary. Use a local const to carry the narrowed type forward.
  const resolvedToolName: string = toolName!;

  // Only process known ashlr tools
  const nativeEquivalents = ASHLR_TO_NATIVE[resolvedToolName];
  if (!nativeEquivalents) await exit(0);

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // After nativeEquivalents guard, TypeScript can't narrow across async boundary.
  const resolvedNative: string[] = nativeEquivalents!;

  // Read recent blocks and find matches within window
  const blocks = readRecentBlocks();
  const matches = blocks.filter(
    (b) => b.ts >= cutoff && resolvedNative.includes(b.toolName)
  );

  if (matches.length === 0) {
    // Still prune stale entries
    pruneOldBlocks(WINDOW_MS * 2);
    await exit(0);
  }

  // Emit one event per matched block
  try {
    const { logEvent } = await import("../servers/_events");
    for (const match of matches) {
      await logEvent("tool_called_after_block", {
        tool: resolvedToolName,
        extra: {
          nativeToolBlocked: match.toolName,
          blockTs: match.ts,
          latencyMs: now - match.ts,
          pattern: match.pattern,
          filePath: match.filePath,
        },
      });
    }
  } catch {
    // Telemetry must never surface errors.
  }

  // Prune old entries (keep any that are still within the window but unmatched)
  pruneOldBlocks(WINDOW_MS * 2);

  await exit(0);
});
