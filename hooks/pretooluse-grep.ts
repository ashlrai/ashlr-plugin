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
  getHookMode,
  isInsideCwd,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const hookStartedAt = Date.now();
let observedTool: string | undefined;
let outcome: "ok" | "bypass" | "block" | "error" = "ok";
process.on("exit", (code) => {
  if (outcome === "ok" && code === 2) outcome = "block";
  recordHookTiming({
    hook: "pretooluse-grep",
    tool: observedTool,
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
});

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) process.exit(0);

observedTool = payload.tool_name || undefined;
if (payload.tool_name !== "Grep") process.exit(0);
if (payload.bypass) {
  outcome = "bypass";
  process.exit(0);
}

const pluginRoot = pluginRootFrom(import.meta.url);
// Never redirect a Grep that's explicitly scoped inside the plugin tree —
// agents editing the plugin itself need direct access to rg behavior.
if (payload.search_path && isInsidePluginRoot(payload.search_path, pluginRoot)) {
  process.exit(0);
}

// Legacy back-compat: `ASHLR_ENFORCE=1` → exit-code-based block on stderr.
if (!enforcementDisabled()) {
  // Escape double-quotes for display only.
  const safePattern = payload.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  process.stderr.write(
    `ashlr: routing Grep through ashlr__grep for genome-aware retrieval (saves tokens when genome exists, truncates otherwise). Call ashlr__grep with pattern="${safePattern}". Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
}

// v1.18: default redirect mode. If the caller supplied a search_path that
// lies outside cwd, fall back to nudge — never block on paths the user
// didn't explicitly bring into scope. Grep without a path implicitly runs
// in cwd, which is fine to redirect.
const mode = getHookMode();
const outOfScope =
  !!payload.search_path && !isInsideCwd(payload.search_path);
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  process.exit(0);
}
if (mode === "nudge" || outOfScope) {
  // Port of the retired hooks/tool-redirect.ts nudge: always emit an
  // `additionalContext` suggestion for Grep (the token win is universal).
  const nudge = buildNudgeContext("Grep", { pattern: payload.pattern });
  process.stdout.write(JSON.stringify(nudge ?? buildPassThrough()));
  process.exit(0);
}

const safePattern = payload.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const pathSuffix = payload.search_path ? `, "path": "${payload.search_path}"` : "";
const reason =
  `[ashlr] Blocking the built-in Grep. Call ` +
  `mcp__plugin_ashlr_ashlr__ashlr__grep instead — it uses genome-aware ` +
  `retrieval when .ashlrcode/genome/ exists and a truncated ripgrep fallback ` +
  `otherwise. Equivalent call: { "pattern": "${safePattern}"${pathSuffix} }. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
outcome = "block";
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
process.exit(0);
