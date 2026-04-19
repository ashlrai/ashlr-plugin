#!/usr/bin/env bun
/**
 * post-tool-use-embedding.ts — Re-embed edited files after ashlr__edit / ashlr__multi_edit.
 *
 * PostToolUse hook. Reads the tool result JSON from stdin, extracts the file
 * path(s), then queues re-embedding in a completely detached child process so
 * the hook returns immediately (fire-and-forget, < 1 ms impact on tool chain).
 *
 * Honors:
 *   ASHLR_CONTEXT_DB_DISABLE=1  — exits immediately; no-op
 *   ASHLR_EMBED_URL             — forwarded to child (remote embedder)
 *   ASHLR_EMBED_MODEL           — forwarded to child
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") process.exit(0);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(scriptDir, "..");

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  } catch {
    process.exit(0);
  }

  // Extract file paths from tool input (works for both ashlr__edit and ashlr__multi_edit).
  const paths: string[] = [];

  const input = payload.tool_input as Record<string, unknown> | undefined;
  if (input) {
    // ashlr__edit: { path: string }
    if (typeof input.path === "string") paths.push(input.path);
    // ashlr__multi_edit: { edits: Array<{ path: string }> }
    if (Array.isArray(input.edits)) {
      for (const e of input.edits as Array<Record<string, unknown>>) {
        if (typeof e.path === "string") paths.push(e.path);
      }
    }
  }

  if (paths.length === 0) process.exit(0);

  // Spawn detached worker — inherits env, writes to /dev/null, exits on its own.
  const workerScript = resolve(pluginRoot, "scripts", "embed-file-worker.ts");

  try {
    const proc = Bun.spawn(
      ["bun", "run", workerScript, ...paths],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        // detached so it outlives this hook process
        env: {
          ...process.env,
          ASHLR_CONTEXT_DB_DISABLE: process.env.ASHLR_CONTEXT_DB_DISABLE ?? "0",
        },
      }
    );
    // Don't await — fire-and-forget.
    proc.unref?.();
  } catch {
    /* best-effort */
  }

  process.exit(0);
});
