/**
 * write-server — ashlr__write tool implementation.
 *
 * Handles two cases:
 *   1. File exists: delegates to ashlrEdit (full-file replace). The compact
 *      diff summary from ashlrEdit is returned unchanged — same format,
 *      ~80% token savings vs echoing the full new file.
 *   2. File is new: writes it directly and returns a compact ack (path,
 *      byte count, first-8-chars of sha256). Never echoes the content.
 *
 * Savings baseline:
 *   - existing file: raw = content.length (Claude Code would echo it back);
 *      compact = ashlrEdit's compact diff. recordSaving is already called
 *      by ashlrEdit internally; no double-record here.
 *   - new file: raw = content.length; compact = ack JSON bytes.
 */

import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { recordSaving } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";
import { ashlrEdit, type EditResult } from "./edit-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriteArgs {
  filePath: string;
  content: string;
}

export interface WriteNewResult {
  created: string;
  bytes: number;
  sha8: string;
}

export type WriteResult =
  | { kind: "new"; ack: WriteNewResult }
  | { kind: "existing"; editResult: EditResult };

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export async function ashlrWrite(input: WriteArgs): Promise<WriteResult> {
  const { filePath, content } = input;

  const clamp = clampToCwd(filePath, "ashlr__write");
  if (!clamp.ok) throw new Error(clamp.message);
  const abs = clamp.abs;

  // Case 1: file exists — delegate to ashlrEdit (full-file replace).
  // ashlrEdit internally calls recordSaving, so we don't double-record.
  if (existsSync(abs)) {
    const existingContent = await readFile(abs, "utf-8");
    // Full-file replace: search = entire existing content, replace = new content.
    const editResult = await ashlrEdit({
      path: filePath,
      search: existingContent,
      replace: content,
      strict: true,
    });
    return { kind: "existing", editResult };
  }

  // Case 2: new file — write it and return compact ack.
  await writeFile(abs, content, "utf-8");

  const sha8 = createHash("sha256").update(content).digest("hex").slice(0, 8);
  const ack: WriteNewResult = {
    created: abs,
    bytes: content.length,
    sha8,
  };

  // Record savings: raw = content bytes (what Claude Code would echo back);
  // compact = ack JSON bytes.
  const compactBytes = JSON.stringify(ack).length;
  await recordSaving(content.length, compactBytes, "ashlr__write");

  return { kind: "new", ack };
}

/**
 * Format the WriteResult as a human-readable text response for the MCP tool.
 */
export function formatWriteResult(result: WriteResult): string {
  if (result.kind === "new") {
    const { created, bytes, sha8 } = result.ack;
    return `[ashlr__write] created ${created}  ·  ${bytes} bytes  ·  sha8=${sha8}`;
  }
  // Delegate to the edit result text directly — same compact diff format.
  return result.editResult.text;
}
