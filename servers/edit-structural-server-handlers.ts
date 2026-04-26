/**
 * edit-structural-server-handlers — registers ashlr__edit_structural on the
 * shared registry (Track C v1.14).
 *
 * v1.14 adds:
 *   - operation: "rename" (default, file-local) | "rename-cross-file" | "extract-function"
 *   - rename-cross-file: rootDir + optional include/exclude globs, applies edits
 *     atomically across all matching files.
 *   - extract-function: byte-range extract with outer-scope param detection (MVP).
 *
 * Input (operation: "rename", default for back-compat):
 *   - path (required)    — absolute or cwd-relative file path
 *   - name (required)    — identifier name to rename
 *   - newName (required) — target name
 *   - kind?              — "value" (default) | "type"
 *   - dryRun?            — if true, return the planned edits without writing
 *   - force?             — bypass shadowing + collision guards
 *
 * Input (operation: "rename-cross-file"):
 *   - rootDir (required) — cwd-clamped root directory to search
 *   - name (required)    — identifier name to rename
 *   - newName (required) — target name
 *   - kind?              — "value" (default) | "type"
 *   - include?           — glob patterns (default: **\/*.{ts,tsx,js,jsx})
 *   - exclude?           — glob patterns to exclude
 *   - dryRun?            — if true, plan but don't write
 *
 * Input (operation: "extract-function"):
 *   - path (required)         — source file path
 *   - newName (required)      — name for the extracted function
 *   - start (required)        — byte offset start of range to extract
 *   - end (required)          — byte offset end of range to extract
 *   - dryRun?                 — if true, return edits without writing
 */

import { writeFile } from "fs/promises";
import {
  registerTool,
  toErrorResult,
  type ToolCallContext,
  type ToolResult,
} from "./_tool-base";
import { clampToCwd } from "./_cwd-clamp";
import {
  applyRangeEdits,
  applyCrossFileRenameEdits,
  planRenameInFile,
  planCrossFileRename,
  planExtractFunction,
  type RefactorKind,
} from "./_ast-refactor";
import { parseFile } from "./_ast-helpers";
import { recordSaving } from "./_stats";

interface StructuralArgs {
  operation?: unknown;
  path?: unknown;
  rootDir?: unknown;
  name?: unknown;
  newName?: unknown;
  kind?: unknown;
  dryRun?: unknown;
  force?: unknown;
  include?: unknown;
  exclude?: unknown;
  anchorFile?: unknown;
  maxFiles?: unknown;
  start?: unknown;
  end?: unknown;
}

registerTool({
  name: "ashlr__edit_structural",
  description:
    "Rename a symbol with AST awareness (one file or N files). Use instead of native " +
    "Edit when renaming variables/functions/types — avoids accidental matches in " +
    "strings/comments. Compresses by returning only a rename summary; typical savings " +
    "80–95%. operation='rename': file-local. operation='rename-cross-file': across " +
    "rootDir. operation='extract-function': extract byte-range to new function. " +
    "Supports .ts/.tsx/.js/.jsx. dryRun=true previews. Use ashlr__edit for literal edits.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["rename", "rename-cross-file", "extract-function"],
        description: "Operation to perform (default: 'rename' for back-compat)",
      },
      path: { type: "string", description: "Absolute or cwd-relative file path (rename, extract-function)" },
      rootDir: { type: "string", description: "Root directory to search (rename-cross-file)" },
      name: { type: "string", description: "Current identifier name to rename (rename, rename-cross-file)" },
      newName: { type: "string", description: "Target identifier / new function name" },
      kind: {
        type: "string",
        enum: ["value", "type"],
        description: "'value' (default) | 'type' — for rename operations",
      },
      dryRun: {
        type: "boolean",
        description: "If true, return the planned edits without writing (default false)",
      },
      force: {
        type: "boolean",
        description: "Bypass shadowing + collision guards for rename (default false)",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns to include (rename-cross-file, default: **/*.{ts,tsx,js,jsx})",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns to exclude (rename-cross-file)",
      },
      anchorFile: {
        type: "string",
        description: "Absolute path of the file that declares + exports the symbol (rename-cross-file). When set, only files that import the symbol from this file are renamed — unrelated local same-named identifiers are left alone.",
      },
      maxFiles: {
        type: "number",
        description: "Hard cap on candidate files for cross-file rename (default 200). Beyond this the rename is truncated and a warning is emitted.",
      },
      start: { type: "number", description: "Byte offset start of range to extract (extract-function)" },
      end: { type: "number", description: "Byte offset end of range to extract (extract-function)" },
    },
    required: ["newName"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const a = args as StructuralArgs;
    const operation = typeof a.operation === "string" ? a.operation : "rename";
    const dryRun = a.dryRun === true;

    try {
      if (operation === "rename-cross-file") {
        return await handleCrossFileRename(a, dryRun);
      } else if (operation === "extract-function") {
        return await handleExtractFunction(a, dryRun);
      } else {
        return await handleFileLocalRename(a, dryRun);
      }
    } catch (err) {
      return toErrorResult("ashlr__edit_structural error", err);
    }
  },
});

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

async function handleFileLocalRename(a: StructuralArgs, dryRun: boolean): Promise<ToolResult> {
  const path = typeof a.path === "string" ? a.path : "";
  const name = typeof a.name === "string" ? a.name : "";
  const newName = typeof a.newName === "string" ? a.newName : "";
  const kind: RefactorKind = a.kind === "type" ? "type" : "value";
  const force = a.force === true;

  if (!path) return errText("ashlr__edit_structural: 'path' is required");
  if (!name) return errText("ashlr__edit_structural: 'name' is required");
  if (!newName) return errText("ashlr__edit_structural: 'newName' is required");

  const clamp = clampToCwd(path, "ashlr__edit_structural");
  if (!clamp.ok) return errText(clamp.message);

  const result = await planRenameInFile(clamp.abs, name, newName, { kind, force });
  if (!result.ok) {
    return errText(`ashlr__edit_structural: ${result.reason}`);
  }

  const header =
    `[ashlr__edit_structural] rename ${kind} '${name}' → '${newName}' in ${path}\n` +
    `  ${result.references} occurrence${result.references === 1 ? "" : "s"} updated` +
    (result.warnings.length > 0 ? `\n  warnings: ${result.warnings.join("; ")}` : "");

  if (dryRun) {
    const lines = [header, "  (dry run — file not written)", "  planned edits:"];
    for (const e of result.edits) {
      lines.push(`    [${e.start}, ${e.end}] → '${e.replacement}'`);
    }
    return okText(lines.join("\n"));
  }

  const sourceBefore = result.source;
  const sourceAfter = applyRangeEdits(sourceBefore, result.edits);
  if (sourceBefore === sourceAfter) {
    return okText(header + "\n  (no-op — source unchanged after rewrite)");
  }
  await writeFile(clamp.abs, sourceAfter, "utf-8");

  const rawBytes = Buffer.byteLength(sourceBefore, "utf-8");
  const compactBytes = Buffer.byteLength(header, "utf-8");
  await recordSaving(rawBytes, compactBytes, "ashlr__edit_structural");

  return okText(header);
}

async function handleCrossFileRename(a: StructuralArgs, dryRun: boolean): Promise<ToolResult> {
  const rootDir = typeof a.rootDir === "string" ? a.rootDir : "";
  const name = typeof a.name === "string" ? a.name : "";
  const newName = typeof a.newName === "string" ? a.newName : "";
  const kind: RefactorKind = a.kind === "type" ? "type" : "value";
  const include = Array.isArray(a.include) ? (a.include as string[]) : undefined;
  const exclude = Array.isArray(a.exclude) ? (a.exclude as string[]) : undefined;
  const anchorFileRaw = typeof a.anchorFile === "string" ? a.anchorFile : undefined;
  const maxFiles = typeof a.maxFiles === "number" ? a.maxFiles : undefined;

  if (!rootDir) return errText("ashlr__edit_structural (rename-cross-file): 'rootDir' is required");
  if (!name) return errText("ashlr__edit_structural (rename-cross-file): 'name' is required");
  if (!newName) return errText("ashlr__edit_structural (rename-cross-file): 'newName' is required");

  const clamp = clampToCwd(rootDir, "ashlr__edit_structural");
  if (!clamp.ok) return errText(clamp.message);

  let anchorFile: string | undefined;
  if (anchorFileRaw) {
    const aClamp = clampToCwd(anchorFileRaw, "ashlr__edit_structural");
    if (!aClamp.ok) return errText(aClamp.message);
    anchorFile = aClamp.abs;
  }

  const result = await planCrossFileRename(clamp.abs, name, newName, {
    kind,
    include,
    exclude,
    anchorFile,
    maxFiles,
  });
  if (!result.ok) {
    return errText(`ashlr__edit_structural (rename-cross-file): ${result.reason}`);
  }

  const totalRefs = result.fileEdits.reduce((s, f) => s + f.references, 0);
  const header =
    `[ashlr__edit_structural] cross-file rename '${name}' → '${newName}'` +
    (anchorFile ? ` (scoped to importers of ${anchorFile})` : "") + "\n" +
    `  ${result.fileEdits.length} file${result.fileEdits.length === 1 ? "" : "s"}, ${totalRefs} occurrence${totalRefs === 1 ? "" : "s"} updated` +
    (result.skipped ? `, ${result.skipped} candidate${result.skipped === 1 ? "" : "s"} skipped` : "") +
    (result.warnings.length > 0 ? `\n  warnings:\n${result.warnings.map((w) => `    ${w}`).join("\n")}` : "");

  if (dryRun) {
    // List every planned edit so the caller can review before committing.
    const lines = [header, "  (dry run — files not written)", "  planned edits:"];
    for (const fe of result.fileEdits) {
      lines.push(`    ${fe.path} — ${fe.edits.length} edit${fe.edits.length === 1 ? "" : "s"}`);
      for (const e of fe.edits) {
        lines.push(`      [${e.start}, ${e.end}] → '${e.replacement}'`);
      }
    }
    return okText(lines.join("\n"));
  }

  const written = await applyCrossFileRenameEdits(result.fileEdits);
  const summary = header + `\n  ${written} file${written === 1 ? "" : "s"} written`;

  const totalRawBytes = result.fileEdits.reduce((s, f) => s + Buffer.byteLength(f.source, "utf-8"), 0);
  await recordSaving(totalRawBytes, Buffer.byteLength(summary, "utf-8"), "ashlr__edit_structural");

  return okText(summary);
}

async function handleExtractFunction(a: StructuralArgs, dryRun: boolean): Promise<ToolResult> {
  const path = typeof a.path === "string" ? a.path : "";
  const newName = typeof a.newName === "string" ? a.newName : "";
  const start = typeof a.start === "number" ? a.start : -1;
  const end = typeof a.end === "number" ? a.end : -1;

  if (!path) return errText("ashlr__edit_structural (extract-function): 'path' is required");
  if (!newName) return errText("ashlr__edit_structural (extract-function): 'newName' is required");
  if (start < 0) return errText("ashlr__edit_structural (extract-function): 'start' is required");
  if (end < 0) return errText("ashlr__edit_structural (extract-function): 'end' is required");

  const clamp = clampToCwd(path, "ashlr__edit_structural");
  if (!clamp.ok) return errText(clamp.message);

  const parsed = await parseFile(clamp.abs);
  if (!parsed) {
    return errText("ashlr__edit_structural (extract-function): unsupported language or grammar not wired");
  }

  const result = planExtractFunction(parsed, { newFunctionName: newName, start, end });
  if (!result.ok) {
    return errText(`ashlr__edit_structural (extract-function): ${result.reason}`);
  }

  const warnings = result.warnings ?? [];
  const header =
    `[ashlr__edit_structural] extract-function '${newName}' from ${path} [${start}–${end}]` +
    (warnings.length > 0 ? `\n  warnings:\n${warnings.map((w) => `    ${w}`).join("\n")}` : "");

  if (dryRun) {
    const lines = [header, "  (dry run — file not written)", "  planned edits:"];
    for (const e of result.edits!) {
      // Truncate long replacements for readability
      const repl = e.replacement.length > 120
        ? e.replacement.slice(0, 117) + "..."
        : e.replacement;
      lines.push(`    [${e.start}, ${e.end}] → ${JSON.stringify(repl)}`);
    }
    return okText(lines.join("\n"));
  }

  const sourceAfter = applyRangeEdits(result.source!, result.edits!);
  await writeFile(clamp.abs, sourceAfter, "utf-8");

  const rawBytes = Buffer.byteLength(result.source!, "utf-8");
  await recordSaving(rawBytes, Buffer.byteLength(header, "utf-8"), "ashlr__edit_structural");

  return okText(header + "\n  written");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errText(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
