#!/usr/bin/env bun
/**
 * pretooluse-edit.ts — Cross-platform replacement for pretooluse-edit.sh.
 *
 * Blocks the built-in Edit tool on files larger than 5KB and redirects the
 * agent to ashlr__edit (diff-format, ~80% token savings).
 *
 * Enforcement is OFF by default (ASHLR_ENFORCE=1 to enable).
 */

import { statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const THRESHOLD = 5120;

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

  if (toolName !== "Edit") process.exit(0);
  if (!filePath) process.exit(0);
  if (bypass) process.exit(0);

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

  process.stderr.write(
    `ashlr: refusing full Edit on large file ${filePath} (${size} bytes). Call ashlr__edit with diff-format to save ~80% tokens. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
});
