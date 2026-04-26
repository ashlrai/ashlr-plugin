#!/usr/bin/env bun
/**
 * pretooluse-grep.ts — Cross-platform replacement for pretooluse-grep.sh.
 *
 * v1.18: by default, this hook BLOCKS the native Grep tool and routes the
 * agent to ashlr__grep (genome-aware RAG or truncated rg fallback). Set
 * `ASHLR_HOOK_MODE=nudge` to downgrade to a soft `additionalContext`
 * suggestion (the old v1.17 tool-redirect.ts behavior, absorbed into this
 * hook after tool-redirect.ts was retired). Set `ASHLR_HOOK_MODE=off` — or
 * `~/.ashlr/settings.json { toolRedirect: false }` — for total pass-through.
 *
 * Legacy: `ASHLR_ENFORCE=1` continues to use the exit-2 + stderr protocol
 * for back-compat with existing harness configs and the hook-timings tests.
 */

import {
  buildNudgeContext,
  buildPassThrough,
  buildRedirectBlock,
  enforcementDisabled,
  flushHookTimings,
  getHookMode,
  isInsideCwd,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";
import { recordBlock } from "./_recent-blocks";

const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-grep", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "Grep") await exit(0, "ok", tool);
if (payload!.bypass) await exit(0, "bypass", tool);

const pluginRoot = pluginRootFrom(import.meta.url);
// Never redirect a Grep that's explicitly scoped inside the plugin tree —
// agents editing the plugin itself need direct access to rg behavior.
if (payload!.search_path && isInsidePluginRoot(payload!.search_path, pluginRoot)) {
  await exit(0, "ok", tool);
}

// Legacy back-compat: `ASHLR_ENFORCE=1` → exit-code-based block on stderr.
if (!enforcementDisabled()) {
  const safePattern = payload!.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  process.stderr.write(
    `ashlr: routing Grep through ashlr__grep for genome-aware retrieval (saves tokens when genome exists, truncates otherwise). Call ashlr__grep with pattern="${safePattern}". Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  await exit(2, "block", tool);
}

// v1.18: default redirect mode. If the caller supplied a search_path that
// lies outside cwd, fall back to nudge — never block on paths the user
// didn't explicitly bring into scope. Grep without a path implicitly runs
// in cwd, which is fine to redirect.
const mode = getHookMode();
const outOfScope = !!payload!.search_path && !isInsideCwd(payload!.search_path);
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}
if (mode === "nudge" || outOfScope) {
  const nudge = buildNudgeContext("Grep", { pattern: payload!.pattern });
  process.stdout.write(JSON.stringify(nudge ?? buildPassThrough()));
  await exit(0, "ok", tool);
}

const safePattern = payload!.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const pathSuffix = payload!.search_path ? `, "path": "${payload!.search_path}"` : "";
const reason =
  `[ashlr] Blocking the built-in Grep. Call ` +
  `mcp__plugin_ashlr_ashlr__ashlr__grep instead — it uses genome-aware ` +
  `retrieval when .ashlrcode/genome/ exists and a truncated ripgrep fallback ` +
  `otherwise. Equivalent call: { "pattern": "${safePattern}"${pathSuffix} }. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
// Record block for posttooluse-correlate correlation (best-effort, never throws).
recordBlock({ ts: Date.now(), toolName: "Grep", pattern: payload!.pattern });
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
await exit(0, "block", tool);
