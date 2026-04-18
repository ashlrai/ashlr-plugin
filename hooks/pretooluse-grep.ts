#!/usr/bin/env bun
/**
 * pretooluse-grep.ts — Cross-platform replacement for pretooluse-grep.sh.
 *
 * Blocks the built-in Grep tool and redirects the agent to ashlr__grep
 * (genome-aware RAG or truncated rg fallback).
 *
 * Enforcement is OFF by default (ASHLR_ENFORCE=1 to enable).
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

if (process.env.ASHLR_ENFORCE !== "1" || process.env.ASHLR_NO_ENFORCE === "1") {
  process.exit(0);
}

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let toolName = "";
  let pattern = "";
  let searchPath = "";
  let bypass = false;
  try {
    const p = JSON.parse(raw);
    toolName = p?.tool_name ?? "";
    const input = p?.tool_input ?? {};
    pattern = typeof input.pattern === "string" ? input.pattern : "";
    searchPath = typeof input.path === "string" ? input.path : "";
    bypass = input.bypassSummary === true;
  } catch {
    process.exit(0);
  }

  if (toolName !== "Grep") process.exit(0);
  if (bypass) process.exit(0);

  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (searchPath && (searchPath === pluginRoot || searchPath.startsWith(pluginRoot + "/"))) {
    process.exit(0);
  }

  // Escape double-quotes for display only.
  const safePattern = pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  process.stderr.write(
    `ashlr: routing Grep through ashlr__grep for genome-aware retrieval (saves tokens when genome exists, truncates otherwise). Call ashlr__grep with pattern="${safePattern}". Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
});
