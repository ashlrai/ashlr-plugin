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

import {
  enforcementDisabled,
  fileSize,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
} from "./pretooluse-common";

const THRESHOLD = 2048;

if (enforcementDisabled()) process.exit(0);

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) process.exit(0);

if (payload.tool_name !== "Read") process.exit(0);
if (!payload.file_path) process.exit(0);
if (payload.bypass) process.exit(0);

const pluginRoot = pluginRootFrom(import.meta.url);
if (isInsidePluginRoot(payload.file_path, pluginRoot)) process.exit(0);

const size = fileSize(payload.file_path);
if (size === null) process.exit(0);
if (size <= THRESHOLD) process.exit(0);

const savedTokens = Math.max(0, Math.floor((size - 1024) / 4));
process.stderr.write(
  `ashlr: refusing full Read of ${payload.file_path} (${size} bytes). Call ashlr__read instead for snipCompact truncation — saves ~${savedTokens} tokens. Pass bypassSummary: true on ashlr__read if you truly need the raw file. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
);
process.exit(2);
