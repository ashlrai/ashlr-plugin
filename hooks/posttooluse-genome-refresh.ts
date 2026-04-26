#!/usr/bin/env bun
/**
 * posttooluse-genome-refresh.ts — PostToolUse hook that records edited file
 * paths to ~/.ashlr/pending-genome-refresh.txt for incremental genome refresh.
 *
 * Triggers on Edit, Write, MultiEdit, NotebookEdit, and all ashlr MCP edit
 * variants. Appends the absolute file path (deduped) so the genome-refresh-
 * worker can process them at session end.
 *
 * Design rules:
 *   - Never throws, never blocks. Best-effort fire-and-forget.
 *   - Exits 0 always.
 *   - No stdout — must not pollute the hook channel.
 *   - Kill switch: ASHLR_GENOME_AUTO=0
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname, resolve, isAbsolute } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PENDING_FILE_NAME = "pending-genome-refresh.txt";

function pendingPath(home: string = homedir()): string {
  return join(home, ".ashlr", PENDING_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Tool name detection — mirrors genome-scribe-hook.ts EDIT_TOOL_NAMES
// ---------------------------------------------------------------------------

export const WRITE_TOOL_NAMES = new Set<string>([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

export function isWriteTool(name: string | undefined): boolean {
  if (!name) return false;
  if (WRITE_TOOL_NAMES.has(name)) return true;
  // mcp__plugin_ashlr_ashlr__ashlr__edit etc.
  if (!name.startsWith("mcp__")) return false;
  return (
    name.endsWith("ashlr__edit") ||
    name.endsWith("ashlr__write") ||
    name.endsWith("ashlr__multi_edit") ||
    name.endsWith("ashlr__notebook_edit") ||
    name.endsWith("ashlr__edit_structural") ||
    name.endsWith("ashlr__rename_file")
  );
}

// ---------------------------------------------------------------------------
// Path extraction from tool_input
// ---------------------------------------------------------------------------

interface ToolInput {
  file_path?: unknown;
  path?: unknown;
  // rename_file uses old_path / new_path
  old_path?: unknown;
  new_path?: unknown;
  // MultiEdit uses edits[]
  edits?: Array<{ file_path?: unknown }>;
}

export function extractFilePaths(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const inp = toolInput as ToolInput;
  const paths: string[] = [];

  // Single file: file_path or path
  for (const key of ["file_path", "path", "old_path", "new_path"] as const) {
    const v = inp[key];
    if (typeof v === "string" && v.trim()) paths.push(v.trim());
  }

  // MultiEdit: edits[].file_path
  if (Array.isArray(inp.edits)) {
    for (const e of inp.edits) {
      if (e && typeof e === "object") {
        const fp = (e as { file_path?: unknown }).file_path;
        if (typeof fp === "string" && fp.trim()) paths.push(fp.trim());
      }
    }
  }

  // Deduplicate within this payload
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// Pending-list writer
// ---------------------------------------------------------------------------

/**
 * Append absolute paths to the pending file, deduped.
 * Returns true if any paths were added.
 */
export function appendToPending(paths: string[], home?: string): boolean {
  if (paths.length === 0) return false;
  const file = pendingPath(home);
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return false;
  }

  // Read existing set
  const existing = new Set<string>();
  if (existsSync(file)) {
    try {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const t = line.trim();
        if (t) existing.add(t);
      }
    } catch {
      /* ignore */
    }
  }

  // Resolve to absolute paths and filter new-only
  const toAdd: string[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(p);
    if (!existing.has(abs)) {
      existing.add(abs);
      toAdd.push(abs);
    }
  }

  if (toAdd.length === 0) return false;

  try {
    const content = [...existing].filter(Boolean).join("\n") + "\n";
    writeFileSync(file, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: Record<string, unknown>;
}

function editSucceeded(toolResponse: Record<string, unknown> | undefined): boolean {
  if (!toolResponse) return true;
  if (toolResponse.isError === true) return false;
  if (toolResponse.is_error === true) return false;
  if (typeof toolResponse.success === "boolean") return toolResponse.success;
  return true;
}

// ---------------------------------------------------------------------------
// Hook output (pass-through — we never block)
// ---------------------------------------------------------------------------

interface HookOutput {
  hookSpecificOutput: { hookEventName: "PostToolUse"; additionalContext?: string };
}

export function passThrough(): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export function handle(payload: PostToolUsePayload, home?: string): HookOutput {
  try {
    if (process.env.ASHLR_GENOME_AUTO === "0") return passThrough();
    if (!isWriteTool(payload?.tool_name)) return passThrough();
    if (!editSucceeded(payload.tool_response)) return passThrough();

    const paths = extractFilePaths(payload.tool_input);
    appendToPending(paths, home ?? homedir());
  } catch {
    /* best-effort — never throw */
  }
  return passThrough();
}

// ---------------------------------------------------------------------------
// Stdio entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  let payload: PostToolUsePayload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as PostToolUsePayload;
    } catch {
      /* bad input — pass-through */
    }
  }

  process.stdout.write(JSON.stringify(handle(payload)));
}

if (import.meta.main) {
  await main();
}
