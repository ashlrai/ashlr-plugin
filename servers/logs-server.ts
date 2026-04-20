#!/usr/bin/env bun
/**
 * ashlr-logs MCP server.
 *
 * Exposes ashlr__logs — a token-efficient log tail. Reads the last N lines
 * of a log file (or glob), detects severity with a suite of common patterns
 * (bracketed [ERROR], bare "error:", Python tracebacks, JSON {"level":...}),
 * optionally filters by level and/or timestamp, and collapses runs of
 * identical lines into "(42x) same message".
 *
 * Savings are persisted to the shared ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, statSync } from "fs";
import { glob } from "fs/promises";
import { join, isAbsolute } from "path";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { recordSaving as recordSavingCore } from "./_stats";
import { logEvent } from "./_events";

async function recordSaving(
  rawBytes: number,
  compactBytes: number,
  tool: "ashlr__logs",
): Promise<number> {
  return recordSavingCore(rawBytes, compactBytes, tool);
}

// ---------------------------------------------------------------------------
// Last-N-lines reader. Seeks from end of file and reads 64KB chunks backward
// until we've accumulated enough newlines or we hit BOF.
// ---------------------------------------------------------------------------

function readLastLines(absPath: string, nLines: number): string[] {
  const fd = require("fs").openSync(absPath, "r");
  try {
    const size = statSync(absPath).size;
    const chunk = 64 * 1024;
    let offset = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    while (offset > 0 && newlines <= nLines) {
      const toRead = Math.min(chunk, offset);
      offset -= toRead;
      const b = Buffer.alloc(toRead);
      require("fs").readSync(fd, b, 0, toRead, offset);
      buf = Buffer.concat([b, buf]);
      for (let i = 0; i < b.length; i++) if (b[i] === 10) newlines++;
    }
    const text = buf.toString("utf-8");
    const all = text.split("\n");
    // Trim trailing empty (file ended with \n).
    if (all.length && all[all.length - 1] === "") all.pop();
    if (all.length <= nLines) return all;
    return all.slice(all.length - nLines);
  } finally {
    try { require("fs").closeSync(fd); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Level detection
// ---------------------------------------------------------------------------

type Level = "error" | "warn" | "info" | "debug" | "unknown";

// Ordered from most-specific to most-generic. The JSON-log detector runs
// first because logfmt/JSON lines can contain the word "error" as data and
// we want the explicit `level` field to win.
const LEVEL_PATTERNS: Array<{ level: Level; re: RegExp }> = [
  // JSON logs: "level":"error" or 'level':'error'
  { level: "error", re: /"level"\s*:\s*"(?:error|fatal|critical)"/i },
  { level: "warn",  re: /"level"\s*:\s*"(?:warn(?:ing)?)"/i },
  { level: "info",  re: /"level"\s*:\s*"info"/i },
  { level: "debug", re: /"level"\s*:\s*"(?:debug|trace)"/i },
  // logfmt: level=error
  { level: "error", re: /\blevel=(?:error|fatal|critical)\b/i },
  { level: "warn",  re: /\blevel=warn(?:ing)?\b/i },
  { level: "info",  re: /\blevel=info\b/i },
  { level: "debug", re: /\blevel=(?:debug|trace)\b/i },
  // Bracketed: [ERROR] [WARN] [INFO]
  { level: "error", re: /\[(?:ERROR|ERR|FATAL|CRITICAL)\]/ },
  { level: "warn",  re: /\[(?:WARN|WARNING)\]/ },
  { level: "info",  re: /\[INFO\]/ },
  { level: "debug", re: /\[(?:DEBUG|TRACE)\]/ },
  // Python tracebacks always imply an error context.
  { level: "error", re: /^Traceback \(most recent call last\):/ },
  // Bare colon-prefixed: ERROR: / error: (at line start or after timestamp).
  { level: "error", re: /(?:^|\s)(?:ERROR|ERR|FATAL|CRITICAL):/ },
  { level: "warn",  re: /(?:^|\s)(?:WARN|WARNING):/ },
  { level: "info",  re: /(?:^|\s)INFO:/ },
  // Lowercased variants common in many frameworks.
  { level: "error", re: /(?:^|\s)error:/ },
  { level: "warn",  re: /(?:^|\s)warn(?:ing)?:/ },
  // Isolated whole-word uppercase token — weakest signal, last resort.
  { level: "error", re: /(?<![A-Za-z])ERROR(?![A-Za-z])/ },
  { level: "warn",  re: /(?<![A-Za-z])WARN(?:ING)?(?![A-Za-z])/ },
];

function detectLevel(line: string): Level {
  for (const { level, re } of LEVEL_PATTERNS) {
    if (re.test(line)) return level;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Timestamp parsing (best-effort). Returns ms-epoch or null.
// ---------------------------------------------------------------------------

const TS_PATTERNS: RegExp[] = [
  // ISO 8601: 2026-04-14T12:34:56(.789)?(Z|+00:00)?
  /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/,
  // Slashy: 2026/04/14 12:34:56
  /\b(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\b/,
];

function parseTimestamp(line: string): number | null {
  for (const re of TS_PATTERNS) {
    const m = line.match(re);
    if (m) {
      const iso = m[1]!.replace(" ", "T").replace(/\//g, "-");
      const t = Date.parse(iso);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface LogsArgs {
  path: string;
  lines?: number;
  level?: "all" | "error" | "warn" | "error+warn";
  since?: string;
  dedupe?: boolean;
  cwd?: string;
  bypassSummary?: boolean;
}

async function resolvePath(input: string, cwd: string): Promise<string[]> {
  // Detect glob characters.
  if (/[*?\[]/.test(input)) {
    const results: string[] = [];
    for await (const f of glob(input, { cwd })) {
      results.push(join(cwd, f));
    }
    return results;
  }
  const abs = isAbsolute(input) ? input : join(cwd, input);
  return [abs];
}

export async function ashlrLogs(args: LogsArgs): Promise<string> {
  if (!args.path) throw new Error("'path' is required");
  const cwd = args.cwd ?? process.cwd();
  const nLines = typeof args.lines === "number" && args.lines > 0 ? args.lines : 200;
  const levelFilter = args.level ?? "all";
  const dedupe = args.dedupe !== false;

  const sinceMs = args.since ? Date.parse(args.since) : null;
  if (args.since && Number.isNaN(sinceMs as number)) {
    throw new Error(`'since' is not a parseable ISO timestamp: ${args.since}`);
  }

  const paths = await resolvePath(args.path, cwd);
  const existing = paths.filter((p) => existsSync(p));
  if (existing.length === 0) {
    throw new Error(`no files matched: ${args.path}`);
  }

  const blocks: string[] = [];
  let totalRawBytes = 0;
  let totalScanned = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const p of existing) {
    let lines: string[];
    try {
      lines = readLastLines(p, nLines);
    } catch (err) {
      blocks.push(`logs \u00b7 ${p} \u00b7 read error: ${(err as Error).message}`);
      continue;
    }
    const rawBytesForFile = lines.reduce((s, l) => s + l.length + 1, 0);
    totalRawBytes += rawBytesForFile;
    totalScanned += lines.length;

    // Filter + level-tag pass.
    interface Tagged { raw: string; level: Level; ts: number | null }
    const tagged: Tagged[] = [];
    let errCount = 0;
    let warnCount = 0;
    for (const raw of lines) {
      let level: Level;
      let ts: number | null = null;
      try {
        level = detectLevel(raw);
      } catch {
        level = "unknown";
      }
      try {
        ts = parseTimestamp(raw);
      } catch {
        ts = null;
      }
      if (level === "error") errCount++;
      else if (level === "warn") warnCount++;

      if (sinceMs !== null) {
        // Skip lines with no parseable ts (don't fail the whole call).
        if (ts === null) continue;
        if (ts < (sinceMs as number)) continue;
      }

      if (levelFilter === "error" && level !== "error") continue;
      if (levelFilter === "warn" && level !== "warn") continue;
      if (levelFilter === "error+warn" && level !== "error" && level !== "warn") continue;

      tagged.push({ raw, level, ts });
    }

    totalErrors += errCount;
    totalWarnings += warnCount;

    // Dedupe consecutive identical lines.
    const out: string[] = [];
    if (dedupe) {
      let i = 0;
      while (i < tagged.length) {
        let j = i + 1;
        while (j < tagged.length && tagged[j]!.raw === tagged[i]!.raw) j++;
        const run = j - i;
        if (run > 1) {
          // Find a reasonable place to inject the multiplier prefix.
          // We prepend "(NxX) " after any timestamp/level prefix we can detect.
          out.push(`(${run}\u00d7) ${tagged[i]!.raw}`);
        } else {
          out.push(tagged[i]!.raw);
        }
        i = j;
      }
    } else {
      for (const t of tagged) out.push(t.raw);
    }

    const header = `logs \u00b7 ${p} \u00b7 ${lines.length} lines scanned \u00b7 ${errCount} errors \u00b7 ${warnCount} warnings`;
    blocks.push(header + "\n\n" + out.join("\n"));
  }

  let body = blocks.join("\n\n---\n\n");

  // If the emitted body is still bigger than the raw tail, we didn't save
  // anything — just surface the raw. But keep the header block either way.
  void totalErrors;
  void totalWarnings;
  void totalScanned;

  // LLM summarization: trigger when raw tail is large OR many errors detected.
  const trigger = totalRawBytes > 16_384 || totalErrors > 5;
  if (trigger && !args.bypassSummary) {
    const s = await summarizeIfLarge(body, {
      toolName: "ashlr__logs",
      systemPrompt: PROMPTS.logs,
      bypass: false,
      // Force summarization on trigger even if body is below default threshold
      // (e.g. many short error lines exceed errorCount but not 16KB).
      thresholdBytes: 1,
    });
    body = s.text;
  }

  const footer = `\n\n[ashlr__logs \u00b7 ${existing.length} file${existing.length === 1 ? "" : "s"}]`;
  const text = body + footer;

  const logsRawBytes = Math.max(totalRawBytes, body.length);
  await recordSaving(logsRawBytes, text.length, "ashlr__logs");

  const logsBadgeOpts = {
    toolName: "ashlr__logs",
    rawBytes: logsRawBytes,
    outputBytes: text.length,
  };
  if (confidenceTier(logsBadgeOpts) === "low") {
    await logEvent("tool_noop", { tool: "ashlr__logs", reason: "low-confidence" });
  }
  return text + confidenceBadge(logsBadgeOpts);
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-logs", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__logs",
      description:
        "Tail a log file efficiently. Reads the last N lines (default 200), detects severity from bracketed tags, bare prefixes, JSON/logfmt level fields, and Python tracebacks, filters by level and/or ISO timestamp, and collapses runs of identical consecutive lines into '(42x) ...'. Supports glob paths. Lines with no parseable timestamp are skipped (never fatal) when 'since' is set.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Log file path (supports glob)" },
          lines: { type: "number", description: "Tail window (default 200)" },
          level: {
            type: "string",
            description: "Filter: 'all' (default) | 'error' | 'warn' | 'error+warn'",
          },
          since: { type: "string", description: "ISO timestamp \u2014 only lines after this" },
          dedupe: {
            type: "boolean",
            description: "Collapse repeated consecutive lines with count (default: true)",
          },
          bypassSummary: {
            type: "boolean",
            description: "If true, skip LLM summarization and return the full rendered log tail.",
          },
        },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__logs") {
      const text = await ashlrLogs((args ?? {}) as unknown as LogsArgs);
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr__logs error: ${message}` }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void readFileSync;
