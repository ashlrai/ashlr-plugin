#!/usr/bin/env bun
/**
 * pretooluse-grep.ts — Cross-platform replacement for pretooluse-grep.sh.
 *
 * Blocks the built-in Grep tool and redirects the agent to ashlr__grep
 * (genome-aware RAG or truncated rg fallback).
 *
 * Enforcement is OFF by default (ASHLR_ENFORCE=1 to enable).
 */

import {
  enforcementDisabled,
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

if (enforcementDisabled()) process.exit(0);

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
if (payload.search_path && isInsidePluginRoot(payload.search_path, pluginRoot)) {
  process.exit(0);
}

// Escape double-quotes for display only.
const safePattern = payload.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
process.stderr.write(
  `ashlr: routing Grep through ashlr__grep for genome-aware retrieval (saves tokens when genome exists, truncates otherwise). Call ashlr__grep with pattern="${safePattern}". Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
);
process.exit(2);
