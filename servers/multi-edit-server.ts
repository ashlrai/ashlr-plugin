#!/usr/bin/env bun
/**
 * ashlr-multi-edit MCP server.
 *
 * Exposes ashlr__multi_edit — atomic batched edits across N files in one
 * roundtrip. Each edit is like ashlr__edit (path + search + replace + strict),
 * but all N edits are applied atomically: if any fails, every prior edit is
 * rolled back using the cached original content. Files are read once per path
 * and written once per path at the end, after all edits succeed.
 *
 * Savings: baseline = sum(original.length + updated.length) across all files,
 * which is what N naive Edit calls would have shipped. We record savings via
 * the shared recordSaving from _stats.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "fs/promises";
import { recordSaving } from "./_stats";
import { refreshGenomeAfterEdit } from "./_genome-live";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SingleEdit {
  path: string;
  search: string;
  replace: string;
  /** Default true: require exactly one match. Pass false to replace all. */
  strict?: boolean;
}

export interface MultiEditArgs {
  edits: SingleEdit[];
}

// ---------------------------------------------------------------------------
// Token estimation (same formula as efficiency-server)
// ---------------------------------------------------------------------------

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 72);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function ashlrMultiEdit(input: MultiEditArgs): Promise<string> {
  const { edits } = input;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("ashlr__multi_edit: 'edits' must be a non-empty array");
  }

  // Validate fields + clamp each path to cwd before any FS I/O. Fail-fast so
  // we never partially apply a batch on an out-of-cwd path.
  const clampedPaths: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    if (!e.path) throw new Error(`ashlr__multi_edit: edit[${i}] missing 'path'`);
    if (!e.search) throw new Error(`ashlr__multi_edit: edit[${i}] missing 'search'`);
    const clamp = clampToCwd(e.path, "ashlr__multi_edit");
    if (!clamp.ok) throw new Error(clamp.message);
    clampedPaths.push(clamp.abs);
  }

  // --- Phase 1: read each file once, coalescing by resolved path ---
  const pathToOriginal = new Map<string, string>();
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const abs = clampedPaths[i]!;
    if (pathToOriginal.has(abs)) continue;
    let content: string;
    try {
      content = await readFile(abs, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ashlr__multi_edit: cannot read ${e.path}: ${msg}`);
    }
    pathToOriginal.set(abs, content);
  }

  // --- Phase 2: apply edits in-memory, atomically ---
  // Working copies — rolled back on any failure.
  const working = new Map<string, string>(pathToOriginal);

  // Per-path edit list for the summary (path → list of hunk summaries).
  const perPathHunks = new Map<string, Array<{ search: string; replace: string; count: number; strict: boolean }>>();

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const abs = clampedPaths[i]!;
    const strict = e.strict !== false; // default true
    const current = working.get(abs)!;

    // Count occurrences.
    let count = 0;
    let idx = 0;
    while ((idx = current.indexOf(e.search, idx)) !== -1) {
      count++;
      idx += e.search.length;
    }

    if (count === 0) {
      // Rollback: working map is already in-memory only, nothing written yet.
      throw new Error(
        `ashlr__multi_edit: edit[${i}] search string not found in ${e.path}`,
      );
    }
    if (strict && count > 1) {
      throw new Error(
        `ashlr__multi_edit: edit[${i}] search matched ${count} times in ${e.path}; pass strict:false to replace all, or widen context to a unique span`,
      );
    }

    // Use slice/concat (strict) or split/join (non-strict) to treat `e.replace`
    // as a literal string. String.prototype.replace(string, string) would
    // interpret `$&`, `$1`, `$'`, `` $` `` in the replacement — silently
    // corrupting any edit whose replacement contains a `$` followed by a
    // digit, ampersand, backtick, or apostrophe.
    let updated: string;
    if (strict) {
      const idx = current.indexOf(e.search);
      updated = current.slice(0, idx) + e.replace + current.slice(idx + e.search.length);
    } else {
      updated = current.split(e.search).join(e.replace);
    }

    working.set(abs, updated);

    const hunks = perPathHunks.get(abs) ?? [];
    hunks.push({ search: e.search, replace: e.replace, count, strict });
    perPathHunks.set(abs, hunks);
  }

  // --- Phase 3: write each file once ---
  for (const [abs, content] of working) {
    // Only write files that changed.
    if (content !== pathToOriginal.get(abs)) {
      await writeFile(abs, content, "utf-8");
      // best-effort: refreshGenomeAfterEdit already swallows internally and never rejects; this outer catch is belt-and-braces against a pre-try sync throw (e.g. import init failure) so edits never fail because of observability.
      refreshGenomeAfterEdit(abs, pathToOriginal.get(abs)!, content).catch(() => {});
    }
  }

  // --- Phase 4: build summary and record savings ---
  // v1.22 Trust Pass: baseline is what N naive Edits would have SHIPPED — the
  // sum of each hunk's (search + replace) bytes, NOT the full file contents
  // twice. Aligns multi_edit accounting with the v1.18 single-edit fix
  // (edit-server.ts uses `search.length + replace.length`). Previously this
  // counted full file before+after for each touched file, which inflated the
  // recorded savings 5-10× on small-hunk-into-large-file mass refactors.
  let baseline = 0;
  for (const [, hunks] of perPathHunks) {
    for (const h of hunks) {
      baseline += h.search.length + h.replace.length;
    }
  }

  const fileCount = perPathHunks.size;
  const totalEdits = edits.length;

  const lines: string[] = [
    `[ashlr__multi_edit] applied ${totalEdits} edit${totalEdits === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}:`,
  ];

  for (const [abs, hunks] of perPathHunks) {
    // Find a display path: relative to cwd if possible.
    let displayPath = abs;
    try {
      const rel = abs.startsWith(process.cwd()) ? abs.slice(process.cwd().length + 1) : abs;
      displayPath = rel || abs;
    } catch { /* use abs */ }

    lines.push(`  ${displayPath} (${hunks.length} edit${hunks.length === 1 ? "" : "s"})`);
    for (const h of hunks) {
      lines.push(`    - removed (${estimateTokens(h.search)} tok): ${firstLine(h.search)}${h.search.length > 72 ? "…" : ""}`);
      lines.push(`    + added   (${estimateTokens(h.replace)} tok): ${firstLine(h.replace)}${h.replace.length > 72 ? "…" : ""}`);
    }
  }

  const rawKB = Math.round(baseline / 1024);
  const summaryLength = lines.join("\n").length;
  const compactKB = Math.max(1, Math.round(summaryLength / 1024));
  const savedTok = Math.max(0, Math.ceil((baseline - summaryLength) / 4));

  lines.push(
    `· total: ${totalEdits} hunk${totalEdits === 1 ? "" : "s"} · raw would have been ${rawKB} KB · compressed to ${compactKB} KB · saved ~${savedTok.toLocaleString()} tok`,
  );

  const summary = lines.join("\n");
  await recordSaving(baseline, summary.length, "ashlr__multi_edit");
  return summary;
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-multi-edit", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__multi_edit",
      description:
        "Atomic refactors across files — apply N edits in ONE roundtrip instead of N. " +
        "Either ALL edits succeed or NONE are written (full rollback on any failure). " +
        "Reads each target file once and writes it once regardless of how many edits target it. " +
        "Use this instead of calling ashlr__edit N times for multi-file refactors; saves (N−1) × tool-call overhead and returns one consolidated diff summary.",
      inputSchema: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "Ordered list of edits to apply atomically.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute or cwd-relative file path. File must exist." },
                search: { type: "string", description: "Exact string to find in the file." },
                replace: { type: "string", description: "String to replace it with." },
                strict: {
                  type: "boolean",
                  description: "Default true: require exactly one match (error if 0 or 2+). Pass false to replace all occurrences.",
                },
              },
              required: ["path", "search", "replace"],
            },
          },
        },
        required: ["edits"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__multi_edit") {
      const text = await ashlrMultiEdit((args ?? {}) as unknown as MultiEditArgs);
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
