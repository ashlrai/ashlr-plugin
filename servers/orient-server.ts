#!/usr/bin/env bun
/**
 * ashlr-orient MCP server.
 *
 * Exposes a single tool:
 *   - ashlr__orient — meta-orientation. Answers "how does X work here?" with a
 *     single round-trip: baseline tree scan + keyword-derived file discovery
 *     (genome retriever if present, else ripgrep) + snipCompact'd file reads
 *     + local-LLM synthesis.
 *
 * Replaces 3-5 orientation calls (tree + grep + multiple reads + one synth) the
 * agent would otherwise make in sequence. Read-only; never writes project files.
 *
 * Savings accounting is per-tool via ~/.ashlr/stats.json, shape-compatible with
 * http-server.ts / efficiency-server.ts (byTool[ashlr__orient]).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { statSync } from "fs";
import { readFile } from "fs/promises";
import { join, relative, resolve } from "path";
import { spawnSync } from "child_process";

import {
  formatGenomeForPrompt,
  genomeExists,
  type Message,
  retrieveSectionsV2,
  snipCompact,
} from "@ashlr/core-efficiency";

import { scan, formatBaseline, listFiles } from "../scripts/baseline-scan";
import { readFileSync } from "fs";
import { recordSaving as recordSavingCore } from "./_stats";
import { STOPWORDS, extractKeywords } from "./_text-helpers";

// Re-export for callers that historically imported `extractKeywords` from orient-server.
export { extractKeywords, STOPWORDS };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_FILES = 8;
const MAX_PROMPT_BYTES = 30 * 1024;
const LLM_TIMEOUT_MS = 5_000;
const PER_FILE_CAP = 4_000; // char cap per snipped file before assembly

export const ORIENT_SYSTEM_PROMPT =
  "You are orienting an agent who will code in this repo. Given the query " +
  "and these pre-gathered files, produce a ≤600-char synthesis: what the " +
  "answer is, which files are most relevant (file:line refs), and a " +
  "suggested next tool call for the agent (e.g. `ashlr__read X` or " +
  "`ashlr__grep Y`). Be specific. Don't hallucinate context that isn't shown.";

// Records a saving event against the shared stats store.
async function recordSaving(rawBytes: number, compactBytes: number, tool: string): Promise<void> {
  await recordSavingCore(rawBytes, compactBytes, tool);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

interface DiscoveredFile {
  path: string;    // absolute
  rel: string;     // relative to dir
  snippet: string; // snipCompact'd content, capped
  rawBytes: number;
}

function rgBinary(): string {
  const viaBun = (globalThis as { Bun?: { which(b: string): string | null } }).Bun;
  const found = viaBun?.which("rg") ?? null;
  if (found) return found;
  for (const p of ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]) {
    try { statSync(p); return p; } catch { /* ignore */ }
  }
  return "rg";
}

function grepCandidates(dir: string, keywords: string[], cap: number): string[] {
  if (keywords.length === 0) return [];
  // Build a single alternation pattern; case-insensitive.
  const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const res = spawnSync(rgBinary(), ["-l", "-i", "--max-count=1", pattern, dir], {
    encoding: "utf-8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let lines: string[] = [];
  if (res.status === 0 || res.status === 1) {
    lines = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } else {
    // rg unavailable — fall back to a small in-process scan that matches
    // filename OR file contents. Best-effort; caps itself.
    lines = fallbackFileSearch(dir, keywords, cap * 4);
  }
  // Prefer source-ish files: rank by keyword hits / de-prioritize tests + lockfiles.
  const ranked = lines
    .map((p) => {
      let score = 0;
      for (const k of keywords) if (p.toLowerCase().includes(k)) score += 3;
      if (/\.(test|spec)\./.test(p)) score -= 1;
      if (/node_modules|dist|build|\.lock|\.log$/.test(p)) score -= 10;
      return { p, score };
    })
    .filter((r) => r.score > -5)
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, cap).map((r) => r.p);
}

function fallbackFileSearch(dir: string, keywords: string[], cap: number): string[] {
  const { files } = listFiles(dir, 2000);
  const kw = keywords.map((k) => k.toLowerCase());
  const hits: string[] = [];
  for (const rel of files) {
    if (hits.length >= cap) break;
    const relLower = rel.toLowerCase();
    let matched = kw.some((k) => relLower.includes(k));
    if (!matched) {
      try {
        const buf = readFileSync(join(dir, rel));
        // Cheap: skip files > 256 KB and obvious binaries.
        if (buf.length > 256 * 1024) continue;
        const head = buf.subarray(0, Math.min(buf.length, 32 * 1024)).toString("utf-8").toLowerCase();
        matched = kw.some((k) => head.includes(k));
      } catch { continue; }
    }
    if (matched) hits.push(join(dir, rel));
  }
  return hits;
}

function snipFile(content: string): string {
  const msgs: Message[] = [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "ashlr-orient", content }],
    },
  ];
  const compact = snipCompact(msgs);
  const block = (compact[0]!.content as Array<{ type: string; content: string }>)[0]!;
  const text = (block as { content: string }).content ?? content;
  return text.length > PER_FILE_CAP ? text.slice(0, PER_FILE_CAP) + "\n[... snipped ...]" : text;
}

async function gatherViaGrep(
  dir: string,
  keywords: string[],
  cap: number,
): Promise<DiscoveredFile[]> {
  const paths = grepCandidates(dir, keywords, cap);
  const out: DiscoveredFile[] = [];
  for (const p of paths) {
    try {
      const raw = await readFile(p, "utf-8");
      out.push({
        path: p,
        rel: relative(dir, p),
        snippet: snipFile(raw),
        rawBytes: Buffer.byteLength(raw, "utf-8"),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

async function gatherViaGenome(
  dir: string,
  query: string,
): Promise<{ files: DiscoveredFile[]; genomeText: string }> {
  const sections = await retrieveSectionsV2(dir, query, 4000);
  if (sections.length === 0) return { files: [], genomeText: "" };
  const genomeText = formatGenomeForPrompt(sections);
  const files: DiscoveredFile[] = sections.slice(0, MAX_FILES).map((s) => {
    const content = typeof s.content === "string" ? s.content : "";
    const snippet = content.length > PER_FILE_CAP
      ? content.slice(0, PER_FILE_CAP) + "\n[... snipped ...]"
      : content;
    const rel = (s as { path?: string }).path ?? (s as { title?: string }).title ?? "(genome)";
    return {
      path: join(dir, rel),
      rel,
      snippet,
      rawBytes: Buffer.byteLength(content, "utf-8"),
    };
  });
  return { files, genomeText };
}

// ---------------------------------------------------------------------------
// LLM call (OpenAI-compatible; ASHLR_LLM_URL → fallback LM Studio)
// ---------------------------------------------------------------------------

interface CallLLMOpts {
  systemPrompt: string;
  userContent: string;
  timeoutMs?: number;
  endpointOverride?: string;
}

export async function callLocalLLM(opts: CallLLMOpts): Promise<string | null> {
  const base = opts.endpointOverride ?? process.env.ASHLR_LLM_URL ?? "http://localhost:1234/v1";
  const apiKey = process.env.ASHLR_LLM_KEY ?? "local-llm";
  const model = process.env.ASHLR_LLM_MODEL ?? "qwen/qwen3-coder-30b@8bit";
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 500,
        temperature: 0.1,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userContent },
        ],
      }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main orient()
// ---------------------------------------------------------------------------

export interface OrientArgs {
  query: string;
  dir?: string;
  depth?: "quick" | "thorough";
  /** Test hook: override LLM endpoint. */
  endpointOverride?: string;
}

export interface OrientResult {
  text: string;
  files: string[];
  rawBytes: number;
  outputBytes: number;
  fellBack: boolean;
}

export async function orient(args: OrientArgs): Promise<OrientResult> {
  const dir = resolve(args.dir ?? process.cwd());
  const depth = args.depth ?? "thorough";
  const query = (args.query ?? "").trim();
  const fileCap = depth === "quick" ? 3 : MAX_FILES;

  // 1. Tree scan (reuse baseline-scan).
  let baselineText = "";
  try {
    baselineText = formatBaseline(scan({ dir }));
  } catch {
    baselineText = `[baseline scan failed for ${dir}]`;
  }

  // 2. Keywords.
  const keywords = extractKeywords(query);

  // 3. Discovery: genome first (if present AND we have a non-empty query), else grep.
  let files: DiscoveredFile[] = [];
  let genomeText = "";
  let route: "genome" | "grep" | "none" = "none";
  if (query.length > 0) {
    if (genomeExists(dir)) {
      try {
        const g = await gatherViaGenome(dir, query);
        if (g.files.length > 0) {
          files = g.files.slice(0, fileCap);
          genomeText = g.genomeText;
          route = "genome";
        }
      } catch { /* fall through to grep */ }
    }
    if (files.length === 0 && keywords.length > 0) {
      files = await gatherViaGrep(dir, keywords, fileCap);
      if (files.length > 0) route = "grep";
    }
  }

  // 4. Assemble LLM user content under the 30 KB cap.
  const header =
    `QUERY: ${query || "(empty)"}\n\n` +
    `PROJECT BASELINE:\n${baselineText}\n\n` +
    (route === "genome" ? `GENOME:\n${genomeText}\n\n` : "") +
    `KEYWORDS: ${keywords.join(", ") || "(none)"}\n` +
    `ROUTE: ${route}\n\nFILES:\n`;
  const parts: string[] = [header];
  let bytesSoFar = Buffer.byteLength(header, "utf-8");
  const consulted: string[] = [];
  let totalRawBytes = Buffer.byteLength(baselineText, "utf-8");
  for (const f of files) {
    totalRawBytes += f.rawBytes;
    const block = `--- ${f.rel} ---\n${f.snippet}\n\n`;
    const blockBytes = Buffer.byteLength(block, "utf-8");
    if (bytesSoFar + blockBytes > MAX_PROMPT_BYTES) break;
    parts.push(block);
    bytesSoFar += blockBytes;
    consulted.push(f.rel);
  }
  const userContent = parts.join("");

  // 5. LLM synthesis (with fallback).
  const llmOut = await callLocalLLM({
    systemPrompt: ORIENT_SYSTEM_PROMPT,
    userContent,
    timeoutMs: LLM_TIMEOUT_MS,
    endpointOverride: args.endpointOverride,
  });

  let synthesis: string;
  let fellBack = false;
  if (llmOut) {
    synthesis = llmOut;
  } else {
    fellBack = true;
    const top = consulted.slice(0, 3).join(", ") || "(none found)";
    const nextHint = consulted[0]
      ? `You probably want to read ${consulted[0]} next (e.g. ashlr__read ${consulted[0]}).`
      : keywords[0]
        ? `Try ashlr__grep "${keywords[0]}" to locate relevant code.`
        : "Refine your query with more specific terms.";
    synthesis =
      `[ashlr__orient · LLM unreachable, fallback summary]\n` +
      `Top files: ${top}. Based on keywords: ${keywords.join(", ") || "(none)"}. ${nextHint}`;
  }

  const body =
    synthesis +
    `\n\n[files consulted: ${consulted.length ? consulted.join(", ") : "(none)"} · route: ${route} · depth: ${depth}]`;

  await recordSaving(totalRawBytes, Buffer.byteLength(body, "utf-8"), "ashlr__orient");

  return {
    text: body,
    files: consulted,
    rawBytes: totalRawBytes,
    outputBytes: Buffer.byteLength(body, "utf-8"),
    fellBack,
  };
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-orient", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__orient",
      description:
        "Meta-orientation tool. Answers 'how does X work here?' in a single call: " +
        "runs a project tree scan, derives keywords from your query, discovers relevant " +
        "files (genome retriever if .ashlrcode/genome/ exists, else ripgrep), snipCompacts " +
        "them, and asks a local LLM for a ≤600-char synthesis plus a suggested next tool call. " +
        "Replaces 3-5 round-trips (tree + grep + multiple reads). Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Question about the codebase: 'how does auth work', 'where is X defined', 'what's the deploy flow'",
          },
          dir: {
            type: "string",
            description: "Project root (default: process.cwd())",
          },
          depth: {
            type: "string",
            enum: ["quick", "thorough"],
            description:
              "'quick' (1 tool call + 3 reads, ~2s) | 'thorough' (tree + grep + 6 reads, ~4s, default)",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name !== "ashlr__orient") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const a = (args ?? {}) as Partial<OrientArgs>;
    const out = await orient({
      query: typeof a.query === "string" ? a.query : "",
      dir: typeof a.dir === "string" ? a.dir : undefined,
      depth: a.depth === "quick" || a.depth === "thorough" ? a.depth : undefined,
      endpointOverride: typeof (a as { endpointOverride?: string }).endpointOverride === "string"
        ? (a as { endpointOverride?: string }).endpointOverride
        : undefined,
    });
    return { content: [{ type: "text", text: out.text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr__orient error: ${message}` }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
