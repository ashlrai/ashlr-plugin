#!/usr/bin/env bun
/**
 * ashlr-efficiency MCP server.
 *
 * Exposes token-efficient replacements for Claude Code's built-in file tools:
 *   - ashlr__read  — snipCompact on file contents > 2KB
 *   - ashlr__grep  — genome-aware retrieval when .ashlrcode/genome/ exists,
 *                    ripgrep fallback otherwise
 *   - ashlr__edit  — diff-format edits that avoid sending full file contents
 *
 * Also tracks estimated tokens saved, persisted at ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";

import {
  estimateTokensFromString,
  formatGenomeForPrompt,
  genomeExists,
  type Message,
  retrieveSectionsV2,
  snipCompact,
} from "@ashlr/core-efficiency";

// ---------------------------------------------------------------------------
// Savings tracker
// ---------------------------------------------------------------------------

interface Stats {
  session: { calls: number; tokensSaved: number };
  lifetime: { calls: number; tokensSaved: number };
}

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");
const session: Stats["session"] = { calls: 0, tokensSaved: 0 };

async function loadLifetime(): Promise<Stats["lifetime"]> {
  if (!existsSync(STATS_PATH)) return { calls: 0, tokensSaved: 0 };
  try {
    const raw = JSON.parse(await readFile(STATS_PATH, "utf-8")) as Stats;
    return raw.lifetime ?? { calls: 0, tokensSaved: 0 };
  } catch {
    return { calls: 0, tokensSaved: 0 };
  }
}

async function persistStats(lifetime: Stats["lifetime"]): Promise<void> {
  await mkdir(dirname(STATS_PATH), { recursive: true });
  const payload: Stats = { session, lifetime };
  await writeFile(STATS_PATH, JSON.stringify(payload, null, 2));
}

async function recordSaving(rawChars: number, compactChars: number): Promise<void> {
  const saved = Math.max(0, Math.ceil((rawChars - compactChars) / 4));
  session.calls++;
  session.tokensSaved += saved;
  const lifetime = await loadLifetime();
  lifetime.calls++;
  lifetime.tokensSaved += saved;
  await persistStats(lifetime);
}

// ---------------------------------------------------------------------------
// Tool impls
// ---------------------------------------------------------------------------

async function ashlrRead(input: { path: string }): Promise<string> {
  const abs = resolve(input.path);
  const content = await readFile(abs, "utf-8");

  // Wrap as a fake tool_result message so snipCompact has something to snip.
  const msgs: Message[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "ashlr-read", content },
      ],
    },
  ];

  const compact = snipCompact(msgs);
  const block = (compact[0]!.content as { type: string; content: string }[])[0]!;
  const out = (block as { content: string }).content;

  await recordSaving(content.length, out.length);
  return out;
}

async function ashlrGrep(input: { pattern: string; cwd?: string }): Promise<string> {
  const cwd = input.cwd ?? process.cwd();

  if (genomeExists(cwd)) {
    const sections = await retrieveSectionsV2(cwd, input.pattern, 4000);
    if (sections.length > 0) {
      const formatted = formatGenomeForPrompt(sections);
      // Compare against a hypothetical "full file" grep cost ~ 4x the compressed
      // retrieval. Conservative signal for savings until we have a real baseline.
      await recordSaving(formatted.length * 4, formatted.length);
      return `[ashlr__grep] genome-retrieved ${sections.length} section(s)\n\n${formatted}`;
    }
  }

  // Resolve rg via Bun.which (walks PATH and common Homebrew locations). Shell
  // aliases like Claude Code's own rg wrapper don't resolve under spawn, so we
  // need the actual binary.
  const rgBin =
    (typeof (globalThis as { Bun?: { which(bin: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(bin: string): string | null } }).Bun.which("rg")
      : null) ??
    ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find((p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }) ??
    "rg";

  const res = spawnSync(rgBin, ["--json", "-n", input.pattern, cwd], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  const raw = res.stdout ?? "";
  const truncated = raw.length > 4000 ? raw.slice(0, 2000) + "\n\n[... truncated ...]\n\n" + raw.slice(-1000) : raw;
  await recordSaving(raw.length, truncated.length);
  return truncated || "[no matches]";
}

interface EditArgs {
  path: string;
  search: string;
  replace: string;
  /** When true (default), require exactly one match of `search` for safety. */
  strict?: boolean;
}

interface EditResult {
  text: string;
  hunksApplied: number;
}

async function ashlrEdit(input: EditArgs): Promise<EditResult> {
  const { path: relPath, search, replace, strict = true } = input;
  if (!search) throw new Error("ashlr__edit: 'search' must not be empty");

  const abs = resolve(relPath);
  const original = await readFile(abs, "utf-8");

  // Count occurrences to preserve the safety contract expected by callers.
  let count = 0;
  let idx = 0;
  while ((idx = original.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }

  if (count === 0) throw new Error(`ashlr__edit: search string not found in ${relPath}`);
  if (strict && count > 1) {
    throw new Error(
      `ashlr__edit: search string matched ${count} times in ${relPath}; pass strict:false to replace all, or widen the context to a unique span.`,
    );
  }

  const updated = strict
    ? original.replace(search, replace)
    : original.split(search).join(replace);

  await writeFile(abs, updated, "utf-8");

  // Token accounting: a naive Edit would ship full before+after (2× file). We
  // ship only the diff summary below. Record the savings.
  const naiveBytes = original.length + updated.length;
  const compactSummary = summarizeEdit(relPath, search, replace, count, strict);
  await recordSaving(naiveBytes, compactSummary.length);

  return { text: compactSummary, hunksApplied: strict ? 1 : count };
}

function summarizeEdit(
  relPath: string,
  search: string,
  replace: string,
  matchCount: number,
  strict: boolean,
): string {
  const first = (s: string) => s.split("\n")[0]?.slice(0, 72) ?? "";
  return [
    `[ashlr__edit] ${relPath}  ·  ${strict ? "1 of " + matchCount : matchCount + " of " + matchCount} hunks applied`,
    `  - removed (${estimateTokensFromString(search)} tok):  ${first(search)}${search.length > 72 ? "…" : ""}`,
    `  + added   (${estimateTokensFromString(replace)} tok):  ${first(replace)}${replace.length > 72 ? "…" : ""}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-efficiency", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__read",
      description: "Read a file with automatic snipCompact truncation for results > 2KB. Preserves head + tail, elides middle. Lower-token alternative to the built-in Read tool.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute or cwd-relative file path" } },
        required: ["path"],
      },
    },
    {
      name: "ashlr__grep",
      description: "Search for a pattern. When a .ashlrcode/genome/ directory exists, uses genome-aware retrieval to return only the most relevant sections. Falls back to ripgrep otherwise.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Query or regex" },
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "ashlr__edit",
      description: "Apply a search/replace edit in-place and return only a diff summary. In strict mode (default), requires exactly one match for safety. Set strict:false to replace all occurrences.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          search: { type: "string", description: "Exact text to find" },
          replace: { type: "string", description: "Replacement text" },
          strict: { type: "boolean", description: "Require exactly one match (default: true)" },
        },
        required: ["path", "search", "replace"],
      },
    },
    {
      name: "ashlr__savings",
      description: "Return estimated tokens saved in the current session and lifetime totals.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "ashlr__read": {
        const text = await ashlrRead(args as { path: string });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__grep": {
        const text = await ashlrGrep(args as { pattern: string; cwd?: string });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__edit": {
        const res = await ashlrEdit(args as unknown as EditArgs);
        return { content: [{ type: "text", text: res.text }] };
      }
      case "ashlr__savings": {
        const lifetime = await loadLifetime();
        return {
          content: [{
            type: "text",
            text: `Session: ${session.calls} calls, ~${session.tokensSaved.toLocaleString()} tokens saved\nLifetime: ${lifetime.calls} calls, ~${lifetime.tokensSaved.toLocaleString()} tokens saved`,
          }],
        };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
