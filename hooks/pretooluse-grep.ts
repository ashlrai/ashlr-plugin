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
} from "./pretooluse-common";

if (enforcementDisabled()) process.exit(0);

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) process.exit(0);

if (payload.tool_name !== "Grep") process.exit(0);
if (payload.bypass) process.exit(0);

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
