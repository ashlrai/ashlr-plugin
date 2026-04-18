#!/usr/bin/env bun
/**
 * pretooluse-read.ts — Cross-platform replacement for pretooluse-read.sh.
 *
 * Blocks the built-in Read tool on files larger than 2KB and redirects the
 * agent to ashlr__read (snipCompact truncation, ~60-95% token savings).
 *
 * Contract (Claude Code PreToolUse):
 *   stdin  -> JSON { tool_name, tool_input: { file_path, ... }, ... }
 *   exit 0 -> allow the built-in call
 *   exit 2 -> block; stderr is shown to the agent as a tool error
 *
 * Enforcement is OFF by default (ASHLR_ENFORCE=1 to enable).
 * ASHLR_NO_ENFORCE=1 is honored for back-compat.
 */

import { statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const THRESHOLD = 2048;

// Off by default — tool-redirect.ts nudge is sufficient in normal use.
if (process.env.ASHLR_ENFORCE !== "1" || process.env.ASHLR_NO_ENFORCE === "1") {
  process.exit(0);
}

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let toolName = "";
  let filePath = "";
  let bypass = false;
  try {
    const p = JSON.parse(raw);
    toolName = p?.tool_name ?? "";
    const input = p?.tool_input ?? {};
    filePath = typeof input.file_path === "string" ? input.file_path : "";
    bypass = input.bypassSummary === true;
  } catch {
    process.exit(0);
  }

  if (toolName !== "Read") process.exit(0);
  if (!filePath) process.exit(0);
  if (bypass) process.exit(0);

  // Resolve plugin root from this file's location.
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (filePath.startsWith(pluginRoot)) process.exit(0);

  let size = 0;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) process.exit(0);
    size = st.size;
  } catch {
    process.exit(0);
  }

  if (size <= THRESHOLD) process.exit(0);

  const savedTokens = Math.max(0, Math.floor((size - 1024) / 4));
  process.stderr.write(
    `ashlr: refusing full Read of ${filePath} (${size} bytes). Call ashlr__read instead for snipCompact truncation — saves ~${savedTokens} tokens. Pass bypassSummary: true on ashlr__read if you truly need the raw file. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
});
