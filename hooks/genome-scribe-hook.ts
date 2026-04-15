#!/usr/bin/env bun
/**
 * ashlr genome-scribe PostToolUse hook.
 *
 * Watches successful Edit / ashlr__edit calls. When an edit is substantial
 * (adds/changes > 20 LOC) OR touches an architectural file path
 * (config/, auth/, schema, migration, policy, routing/), we emit an
 * `additionalContext` nudge suggesting the agent call ashlr__genome_propose
 * to record the decision. This is the "active scribe" side of the loop:
 * significant code changes should be accompanied by a genome mutation so
 * project knowledge grows alongside the code.
 *
 * Design rules:
 *   - Never throw. Malformed input, missing fs, missing genome → pass-through.
 *   - Only trigger when .ashlrcode/genome exists in cwd (else the agent has
 *     nothing to propose to).
 *   - No network, no file scanning — must be cheap; runs on every edit.
 *   - Opt-out: `ashlr.genomeScribeAutoNudge: false` in ~/.claude/settings.json.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const EDIT_TOOL_NAMES = new Set<string>([
  "Edit",
  "ashlr__edit",
]);

/** A tool name is an ashlr__edit-ish MCP tool if it ends in "ashlr__edit". */
export function isEditTool(name: string | undefined): boolean {
  if (!name) return false;
  if (EDIT_TOOL_NAMES.has(name)) return true;
  return name.startsWith("mcp__") && name.endsWith("ashlr__edit");
}

export const SUBSTANTIAL_LOC_THRESHOLD = 20;
export const ARCHITECTURAL_PATH_RE =
  /(^|\/)(config|auth|routing)\/|schema|migration|policy/i;

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
}

export function passThrough(): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function settingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export function isAutoNudgeEnabled(home: string = homedir()): boolean {
  const path = settingsPath(home);
  if (!existsSync(path)) return true;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const val = raw["ashlr.genomeScribeAutoNudge"];
    if (val === false) return false;
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Heuristic
// ---------------------------------------------------------------------------

export function genomePresent(cwd: string): boolean {
  return existsSync(join(cwd, ".ashlrcode", "genome"));
}

/**
 * Estimate LOC changed from an Edit tool_input. We only use structural fields
 * we know are present (old_string, new_string, edits[]); never read the file
 * off disk.
 */
export function estimateChangedLoc(
  toolInput: Record<string, unknown> | undefined,
): number {
  if (!toolInput) return 0;
  const countLines = (s: unknown): number =>
    typeof s === "string" ? s.split("\n").length : 0;

  let total = 0;
  // Single-edit form: { old_string, new_string }
  const os = toolInput.old_string;
  const ns = toolInput.new_string;
  if (typeof os === "string" || typeof ns === "string") {
    total += Math.max(countLines(os), countLines(ns));
  }
  // Multi-edit form: { edits: [{ old_string, new_string }, ...] }
  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const rec = e as Record<string, unknown>;
        total += Math.max(countLines(rec.old_string), countLines(rec.new_string));
      }
    }
  }
  return total;
}

export function extractFilePath(
  toolInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolInput) return undefined;
  const fp = toolInput.file_path ?? toolInput.path;
  return typeof fp === "string" ? fp : undefined;
}

/** Was the edit applied successfully? MCP responses vary; be lenient. */
export function editSucceeded(
  toolResponse: Record<string, unknown> | undefined,
): boolean {
  if (!toolResponse) return true; // no signal → assume success
  if (toolResponse.isError === true) return false;
  if (toolResponse.is_error === true) return false;
  if (typeof toolResponse.success === "boolean") return toolResponse.success;
  return true;
}

export interface DecideOpts {
  home?: string;
  cwd?: string;
}

export function decide(
  payload: PostToolUsePayload,
  opts: DecideOpts = {},
): HookOutput {
  try {
    if (!isEditTool(payload?.tool_name)) return passThrough();
    if (!editSucceeded(payload.tool_response)) return passThrough();

    const home = opts.home ?? homedir();
    if (!isAutoNudgeEnabled(home)) return passThrough();

    const cwd = opts.cwd ?? process.cwd();
    if (!genomePresent(cwd)) return passThrough();

    const filePath = extractFilePath(payload.tool_input);
    const loc = estimateChangedLoc(payload.tool_input);
    const architectural = filePath ? ARCHITECTURAL_PATH_RE.test(filePath) : false;
    const substantial = loc > SUBSTANTIAL_LOC_THRESHOLD;

    if (!substantial && !architectural) return passThrough();

    const reason = architectural
      ? `architectural path (${filePath ?? "unknown"})`
      : `${loc} LOC changed`;
    const target = filePath ? ` in ${filePath}` : "";

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[ashlr] Significant change detected${target} (${reason}). ` +
          `Consider calling ashlr__genome_propose with section ` +
          `knowledge/decisions.md to record this decision so it persists ` +
          `across sessions.`,
      },
    };
  } catch {
    return passThrough();
  }
}

// ---------------------------------------------------------------------------
// Stdio entry point
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  let payload: PostToolUsePayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as PostToolUsePayload;
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
    return;
  }
  try {
    process.stdout.write(JSON.stringify(decide(payload)));
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
  }
}

if (import.meta.main) {
  await main();
}
