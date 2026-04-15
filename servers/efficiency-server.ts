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

type ToolName = "ashlr__read" | "ashlr__grep" | "ashlr__edit" | "ashlr__sql" | "ashlr__bash";
const TOOL_NAMES: ToolName[] = ["ashlr__read", "ashlr__grep", "ashlr__edit", "ashlr__sql", "ashlr__bash"];

interface PerTool { calls: number; tokensSaved: number }
interface ByTool { [k: string]: PerTool }
interface ByDay { [date: string]: { calls: number; tokensSaved: number } }

interface SessionStats { startedAt: string; calls: number; tokensSaved: number; byTool: ByTool }
interface LifetimeStats { calls: number; tokensSaved: number; byTool: ByTool; byDay: ByDay }
interface Stats { session: SessionStats; lifetime: LifetimeStats }

// Pricing: USD per million tokens. Default sonnet-4.5 input pricing.
export const PRICING: Record<string, { input: number; output: number }> = {
  "sonnet-4.5": { input: 3.0, output: 15.0 },
  "opus-4":     { input: 15.0, output: 75.0 },
  "haiku-4.5":  { input: 0.8, output: 4.0 },
};
const PRICING_MODEL_DEFAULT = "sonnet-4.5";
function pricingModel(): string {
  return process.env.ASHLR_PRICING_MODEL || PRICING_MODEL_DEFAULT;
}
function costFor(tokens: number, model = pricingModel()): number {
  const p = PRICING[model] ?? PRICING[PRICING_MODEL_DEFAULT]!;
  return (tokens * p.input) / 1_000_000;
}

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

function emptyByTool(): ByTool {
  const o: ByTool = {};
  for (const n of TOOL_NAMES) o[n] = { calls: 0, tokensSaved: 0 };
  return o;
}

const session: SessionStats = {
  startedAt: new Date().toISOString(),
  calls: 0,
  tokensSaved: 0,
  byTool: emptyByTool(),
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Read stats.json, migrating legacy flat shapes. Returns lifetime stats. */
async function loadLifetime(): Promise<LifetimeStats> {
  const empty: LifetimeStats = { calls: 0, tokensSaved: 0, byTool: emptyByTool(), byDay: {} };
  if (!existsSync(STATS_PATH)) return empty;
  try {
    const raw = JSON.parse(await readFile(STATS_PATH, "utf-8")) as Partial<Stats> & {
      lifetime?: Partial<LifetimeStats>;
    };
    const life = raw.lifetime;
    if (!life) return empty;
    return {
      calls: typeof life.calls === "number" ? life.calls : 0,
      tokensSaved: typeof life.tokensSaved === "number" ? life.tokensSaved : 0,
      byTool: { ...emptyByTool(), ...(life.byTool ?? {}) },
      byDay: life.byDay ?? {},
    };
  } catch {
    return empty;
  }
}

async function persistStats(lifetime: LifetimeStats): Promise<void> {
  await mkdir(dirname(STATS_PATH), { recursive: true });
  const payload: Stats = { session, lifetime };
  await writeFile(STATS_PATH, JSON.stringify(payload, null, 2));
}

async function recordSaving(rawChars: number, compactChars: number, toolName: ToolName): Promise<void> {
  const saved = Math.max(0, Math.ceil((rawChars - compactChars) / 4));
  session.calls++;
  session.tokensSaved += saved;
  const st = session.byTool[toolName] ?? (session.byTool[toolName] = { calls: 0, tokensSaved: 0 });
  st.calls++;
  st.tokensSaved += saved;

  const lifetime = await loadLifetime();
  lifetime.calls++;
  lifetime.tokensSaved += saved;
  const lt = lifetime.byTool[toolName] ?? (lifetime.byTool[toolName] = { calls: 0, tokensSaved: 0 });
  lt.calls++;
  lt.tokensSaved += saved;
  const day = todayKey();
  const d = lifetime.byDay[day] ?? (lifetime.byDay[day] = { calls: 0, tokensSaved: 0 });
  d.calls++;
  d.tokensSaved += saved;

  await persistStats(lifetime);
}

// ---------------------------------------------------------------------------
// Savings report rendering
// ---------------------------------------------------------------------------

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function fmtCost(tokens: number): string {
  const c = costFor(tokens);
  if (c < 0.01) return `≈ $${c.toFixed(4)}`;
  return `≈ $${c.toFixed(2)}`;
}

function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) return "";
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(n);
}

function pct(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function renderSavings(lifetime: LifetimeStats): string {
  const model = pricingModel();
  const lines: string[] = [];
  lines.push(`ashlr savings · session started ${formatAge(session.startedAt)} · model ${model}`);
  lines.push("");
  // Summary columns
  const sLabel = `  calls    ${session.calls}`;
  const lLabel = `calls    ${lifetime.calls}`;
  const sSaved = `  saved    ${session.tokensSaved.toLocaleString()} tok`;
  const lSaved = `saved    ${lifetime.tokensSaved.toLocaleString()} tok`;
  const sCost  = `  cost     ${fmtCost(session.tokensSaved)}`;
  const lCost  = `cost     ${fmtCost(lifetime.tokensSaved)}`;
  lines.push(`this session           all-time`);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(1, w - s.length));
  lines.push(pad(sLabel, 25) + lLabel);
  lines.push(pad(sSaved, 25) + lSaved);
  lines.push(pad(sCost, 25)  + lCost);
  lines.push("");

  // By tool (session)
  lines.push("by tool (session):");
  const entries = TOOL_NAMES.map((n) => ({ name: n, ...(session.byTool[n] ?? { calls: 0, tokensSaved: 0 }) }))
    .filter((e) => e.calls > 0 || e.tokensSaved > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved);
  if (entries.length === 0) {
    lines.push("  (no calls yet this session)");
  } else {
    const maxTok = Math.max(...entries.map((e) => e.tokensSaved), 1);
    const totalTok = entries.reduce((s, e) => s + e.tokensSaved, 0);
    for (const e of entries) {
      const name = e.name.padEnd(14);
      const calls = `${e.calls} call${e.calls === 1 ? " " : "s"}`.padEnd(10);
      const tok = `${e.tokensSaved.toLocaleString()} tok`.padEnd(13);
      lines.push(`  ${name}${calls}${tok}${bar(e.tokensSaved, maxTok).padEnd(13)}${pct(e.tokensSaved, totalTok)}`);
    }
  }
  lines.push("");

  // Last 7 days
  lines.push("last 7 days:");
  const days = lastNDays(7);
  const dayVals = days.map((d) => ({ d, v: lifetime.byDay[d]?.tokensSaved ?? 0 }));
  const maxDay = Math.max(...dayVals.map((x) => x.v), 1);
  for (const { d, v } of dayVals) {
    const label = d.slice(5); // MM-DD
    const b = v === 0 ? "(quiet)     " : bar(v, maxDay, 20).padEnd(20);
    const val = v === 0 ? "       0" : v.toLocaleString();
    lines.push(`  ${label}  ${b}  ${val}`);
  }
  return lines.join("\n");
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

  await recordSaving(content.length, out.length, "ashlr__read");
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
      await recordSaving(formatted.length * 4, formatted.length, "ashlr__grep");
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
  await recordSaving(raw.length, truncated.length, "ashlr__grep");
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
  await recordSaving(naiveBytes, compactSummary.length, "ashlr__edit");

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
          content: [{ type: "text", text: renderSavings(lifetime) }],
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
