#!/usr/bin/env bun
/**
 * pretooluse-edit.ts — Cross-platform replacement for pretooluse-edit.sh.
 *
 * Blocks the built-in Edit tool on files larger than 5KB and redirects the
 * agent to ashlr__edit (diff-format, ~80% token savings).
 *
 * Enforcement is OFF by default (ASHLR_ENFORCE=1 to enable).
 */

import {
  enforcementDisabled,
  fileSize,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const THRESHOLD = 5120;

const hookStartedAt = Date.now();
let observedTool: string | undefined;
let outcome: "ok" | "bypass" | "block" | "error" = "ok";
process.on("exit", (code) => {
  if (outcome === "ok" && code === 2) outcome = "block";
  recordHookTiming({
    hook: "pretooluse-edit",
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
if (payload.tool_name !== "Edit") process.exit(0);
if (!payload.file_path) process.exit(0);
if (payload.bypass) {
  outcome = "bypass";
  process.exit(0);
}

const pluginRoot = pluginRootFrom(import.meta.url);
if (isInsidePluginRoot(payload.file_path, pluginRoot)) process.exit(0);

const size = fileSize(payload.file_path);
if (size === null) process.exit(0);
if (size <= THRESHOLD) process.exit(0);

process.stderr.write(
  `ashlr: refusing full Edit on large file ${payload.file_path} (${size} bytes). Call ashlr__edit with diff-format to save ~80% tokens. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
);
process.exit(2);
