/**
 * search-replace-regex-server-handlers — registers
 * ashlr__search_replace_regex on the shared registry (v1.20).
 *
 * Companion to `ashlr__edit` (literal-only, single file) and
 * `ashlr__rename_file` (file rename + importer update). This tool
 * handles the cross-cutting case: "rewrite every match of a regex
 * across N files at once" without resorting to shell + sed.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import {
  ashlrSearchReplaceRegex,
  type SearchReplaceRegexArgs,
} from "./search-replace-regex-server";
import { recordSaving } from "./_stats";

const ERR_PREFIX = "ashlr__search_replace_regex error";

registerTool({
  name: "ashlr__search_replace_regex",
  description:
    "Regex-based bulk substitution across files in one call. Use instead of native Edit when " +
    "patterns are mechanical (X→Y across many call sites) — native Edit doesn't support regex. " +
    "Compresses by returning a per-file match-count summary; typical savings 80–95%. " +
    "Global flag is implicit; supports i/m/s/u; capture groups ($1, $2, $&) in replacement. " +
    "Use dryRun=true to preview. For literal single-file edits use ashlr__edit. " +
    "For AST-aware renames use ashlr__edit_structural.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex source (e.g. 'logger\\\\.info\\\\('). Anchors, classes, and capture groups are all supported.",
      },
      replacement: {
        type: "string",
        description: "Replacement string. JS-style backrefs: $1, $2, $&, $`, $'.",
      },
      flags: {
        type: "string",
        description: "Optional flags subset — i (case-insensitive), m (multiline), s (dotall), u (unicode). The g flag is always implicit.",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "ripgrep-style glob patterns to include (e.g. ['src/**/*.ts']). When omitted, all files under roots are candidates.",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "ripgrep-style glob patterns to exclude (e.g. ['**/node_modules/**']).",
      },
      dryRun: {
        type: "boolean",
        description: "If true, return the planned change set (per-file match counts) without writing. Default false.",
      },
      maxFiles: {
        type: "number",
        description: "Hard cap on candidate files scanned. Default 200. Overflow is truncated with a warning (not a refusal).",
      },
      maxMatchesPerFile: {
        type: "number",
        description: "Hard cap on replacements per file. Default 100. Extra matches are left in place and flagged as capped.",
      },
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Search roots (cwd-relative or absolute). Default: [process.cwd()]. Each is cwd-clamped.",
      },
    },
    required: ["pattern", "replacement"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as unknown as SearchReplaceRegexArgs;
      const { text, originalBytes, newBytes } = await ashlrSearchReplaceRegex(a);
      // Savings accounting: on actual writes, the baseline is the
      // combined byte-size of every rewritten file (what a naive
      // "read every file, round-trip through the model, emit multi_edit"
      // approach would have shipped). We credit the delta between
      // original payload size and the summary text we returned. For
      // dryRun (or zero-file runs) we credit nothing.
      if (!a.dryRun && originalBytes > 0) {
        const compactBytes = Buffer.byteLength(text, "utf-8");
        // Floor at the compact-size of the summary so we never claim
        // a negative saving if the replacement expanded the file.
        const baseline = Math.max(originalBytes, newBytes);
        await recordSaving(baseline, compactBytes, "ashlr__search_replace_regex");
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});
