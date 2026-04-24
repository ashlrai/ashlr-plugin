/**
 * rename-file-server-handlers — registers ashlr__rename_file on the shared
 * registry (Track A · v1.19).
 *
 * Companion to `ashlr__edit_structural`. That tool renames IDENTIFIERS
 * (symbol names); this one renames MODULE PATHS (file locations + every
 * import specifier that resolves to them).
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrRenameFile, type RenameFileArgs } from "./rename-file-server";
import { recordSaving } from "./_stats";

const ERR_PREFIX = "ashlr__rename_file error";

registerTool({
  name: "ashlr__rename_file",
  description:
    "Rename (move) a source file AND update every import specifier in the project that resolved to it. " +
    "Handles extension elision ('./foo' → './bar'), directory-index resolution ('./foo' when foo/index.ts), " +
    "and skips bare package specifiers. Refuses if 'to' already exists, 'to's parent directory is missing, " +
    "paths escape cwd, or either path is a binary file. Supports dryRun. Complements ashlr__edit_structural " +
    "(which renames identifiers, not module paths).",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Current file path (absolute or cwd-relative). Must exist." },
      to: { type: "string", description: "New file path (absolute or cwd-relative). Must NOT exist; parent dir must exist." },
      dryRun: {
        type: "boolean",
        description: "If true, list planned edits without writing or renaming (default false).",
      },
      maxFiles: {
        type: "number",
        description: "Hard cap on importer candidate files (default 200). Beyond this the scan truncates with a warning.",
      },
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Limit the importer scan to these subdirectories (absolute or cwd-relative). Default: process.cwd().",
      },
    },
    required: ["from", "to"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as unknown as RenameFileArgs;
      const text = await ashlrRenameFile(a);
      // Savings accounting: the baseline is the byte-size of the importer
      // source files we rewrote (what a naive "read every candidate and
      // have the model stitch a multi_edit call" approach would have
      // shipped). We don't know the per-file sizes from the summary alone,
      // so approximate via the summary length itself against a nominal
      // multiplier — compact-vs-raw accounting in this tool is a lower
      // bound, not exact. Any positive saving is credited.
      const compactBytes = Buffer.byteLength(text, "utf-8");
      // Claim a conservative 2× multiplier so we don't inflate savings on
      // zero-importer renames; on large renames the real savings are
      // much higher. This is a floor — the router's recordSaving is
      // additive, not a source of truth for per-call math.
      await recordSaving(compactBytes * 2, compactBytes, "ashlr__rename_file");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});
