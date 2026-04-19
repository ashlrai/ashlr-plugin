/**
 * pretooluse-common.ts — Shared helpers for the pretooluse-{read,grep,edit}
 * hooks. Each hook shells out via its own `bun run` entry in hooks.json, so we
 * keep this module dependency-free and side-effect-free.
 *
 * Every helper is designed around the "fail open" contract: if anything looks
 * unexpected we let the built-in tool call proceed by exiting 0, rather than
 * blocking the agent with an error.
 */

import { statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * True when enforcement is disabled — the hook should exit 0 immediately.
 *
 * Enforcement is OFF by default. Only enable when `ASHLR_ENFORCE=1` is set,
 * and still honor `ASHLR_NO_ENFORCE=1` as a kill switch for back-compat.
 */
export function enforcementDisabled(): boolean {
  return process.env.ASHLR_ENFORCE !== "1" || process.env.ASHLR_NO_ENFORCE === "1";
}

/** Read the full stdin payload as a UTF-8 string (trimmed). */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8").trim());
    });
  });
}

export interface PreToolUsePayload {
  tool_name: string;
  file_path: string;
  pattern: string;
  search_path: string;
  bypass: boolean;
}

/**
 * Parse a pretooluse JSON payload. Returns null if the input is empty or
 * malformed (the caller should exit 0 in that case). Missing fields come back
 * as empty strings / false so call-sites can stay uniform.
 */
export function parsePayload(raw: string): PreToolUsePayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const input = p?.tool_input ?? {};
    return {
      tool_name: typeof p?.tool_name === "string" ? p.tool_name : "",
      file_path: typeof input.file_path === "string" ? input.file_path : "",
      pattern: typeof input.pattern === "string" ? input.pattern : "",
      search_path: typeof input.path === "string" ? input.path : "",
      bypass: input.bypassSummary === true,
    };
  } catch {
    return null;
  }
}

/** Absolute path to the plugin root, derived from the calling hook's URL. */
export function pluginRootFrom(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

/** True when `p` lies inside the plugin's own directory tree. */
export function isInsidePluginRoot(p: string, pluginRoot: string): boolean {
  if (!p) return false;
  if (p === pluginRoot) return true;
  return p.startsWith(pluginRoot + "/");
}

/**
 * Return the file size in bytes, or null if the path isn't a regular file
 * (doesn't exist, is a dir, permission denied, etc.). Never throws.
 */
export function fileSize(filePath: string): number | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    return st.size;
  } catch {
    return null;
  }
}
