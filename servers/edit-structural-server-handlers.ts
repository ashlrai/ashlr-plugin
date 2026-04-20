/**
 * edit-structural-server-handlers — registers ashlr__edit_structural on the
 * shared registry (Track C v1.13).
 *
 * v1.13 scope: file-local rename of value or type identifiers in
 * TypeScript/TSX/JS/JSX. Refuses when the target name has >1 declaration
 * site in the file (conservative shadowing guard). Cross-file rename and
 * true scope-aware resolution land in v1.14.
 *
 * Input:
 *   - path (required)   — absolute or cwd-relative file path
 *   - name (required)   — identifier name to rename (e.g. "foo")
 *   - newName (required) — target name
 *   - kind?              — "value" (default) | "type"
 *   - dryRun?            — if true, return the planned edits without writing
 *   - force?             — bypass shadowing + collision guards (advanced)
 */

import { readFile, writeFile } from "fs/promises";
import {
  registerTool,
  type ToolCallContext,
  type ToolResult,
} from "./_tool-base";
import { clampToCwd } from "./_cwd-clamp";
import {
  applyRangeEdits,
  planRenameInFile,
  type RefactorKind,
} from "./_ast-refactor";
import { recordSaving } from "./_stats";

interface StructuralArgs {
  path?: unknown;
  name?: unknown;
  newName?: unknown;
  kind?: unknown;
  dryRun?: unknown;
  force?: unknown;
}

registerTool({
  name: "ashlr__edit_structural",
  description:
    "AST-aware rename of an identifier within ONE file (v1.13). Uses tree-sitter to distinguish value vs type positions and refuses when >1 declaration of the target name exists in the file (shadowing guard). Safer than regex replace; returns a compact diff summary instead of the full file. Supports .ts/.tsx/.js/.jsx today. Cross-file rename + extract-function + inline land in v1.14.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative file path" },
      name: { type: "string", description: "Current identifier name to rename" },
      newName: { type: "string", description: "Target identifier name" },
      kind: {
        type: "string",
        enum: ["value", "type"],
        description: "'value' (default) for runtime identifiers, 'type' for type-only identifiers (interface/type alias/etc.)",
      },
      dryRun: {
        type: "boolean",
        description: "If true, return the planned edits without writing the file (default false)",
      },
      force: {
        type: "boolean",
        description: "Bypass shadowing + collision guards. Only use after you've verified safety (default false)",
      },
    },
    required: ["path", "name", "newName"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const a = args as StructuralArgs;
    const path = typeof a.path === "string" ? a.path : "";
    const name = typeof a.name === "string" ? a.name : "";
    const newName = typeof a.newName === "string" ? a.newName : "";
    const kind: RefactorKind = a.kind === "type" ? "type" : "value";
    const dryRun = a.dryRun === true;
    const force = a.force === true;

    if (!path) return errText("ashlr__edit_structural: 'path' is required");
    if (!name) return errText("ashlr__edit_structural: 'name' is required");
    if (!newName) return errText("ashlr__edit_structural: 'newName' is required");

    const clamp = clampToCwd(path, "ashlr__edit_structural");
    if (!clamp.ok) return okText(clamp.message);

    try {
      const result = await planRenameInFile(clamp.abs, name, newName, { kind, force });
      if (!result.ok) {
        return errText(`ashlr__edit_structural: ${result.reason}`);
      }

      const header =
        `[ashlr__edit_structural] rename ${kind} '${name}' → '${newName}' in ${path}\n` +
        `  ${result.references} occurrence${result.references === 1 ? "" : "s"} updated` +
        (result.warnings.length > 0 ? `\n  warnings: ${result.warnings.join("; ")}` : "");

      if (dryRun) {
        return okText(header + "\n  (dry run — file not written)");
      }

      // Apply edits atomically: read → rewrite → write.
      const sourceBefore = await readFile(clamp.abs, "utf-8");
      const sourceAfter = applyRangeEdits(sourceBefore, result.edits);
      if (sourceBefore === sourceAfter) {
        return okText(header + "\n  (no-op — source unchanged after rewrite)");
      }
      await writeFile(clamp.abs, sourceAfter, "utf-8");

      // Savings accounting: the diff summary we return is ~header bytes,
      // whereas a manual workflow would read the whole file, propose N edits,
      // and re-read. Conservatively account against "raw file size".
      const rawBytes = Buffer.byteLength(sourceBefore, "utf-8");
      const compactBytes = Buffer.byteLength(header, "utf-8");
      await recordSaving(rawBytes, compactBytes, "ashlr__edit_structural");

      return okText(header);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errText(`ashlr__edit_structural error: ${msg}`);
    }
  },
});

function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errText(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
