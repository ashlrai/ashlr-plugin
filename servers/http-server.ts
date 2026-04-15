#!/usr/bin/env bun
/**
 * ashlr-http MCP server — compressed HTTP fetch.
 *
 * Exposes a single tool `ashlr__http` that fetches a URL and returns a
 * compressed representation (default for HTML: extract main content; JSON:
 * pretty + array-elide; raw: no compression beyond byte cap; headers: just
 * response headers). Tracks savings in ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------- shared stats (minimal subset — we write, efficiency-server renders) ----------

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

async function recordSaving(raw: number, compact: number, tool: string): Promise<void> {
  const saved = Math.max(0, Math.ceil((raw - compact) / 4));
  let data: any = {};
  if (existsSync(STATS_PATH)) {
    try { data = JSON.parse(await readFile(STATS_PATH, "utf-8")); } catch { data = {}; }
  }
  data.lifetime = data.lifetime ?? { calls: 0, tokensSaved: 0, byTool: {}, byDay: {} };
  data.session  = data.session  ?? { startedAt: new Date().toISOString(), calls: 0, tokensSaved: 0, byTool: {} };
  for (const scope of [data.lifetime, data.session]) {
    scope.calls++;
    scope.tokensSaved += saved;
    scope.byTool = scope.byTool ?? {};
    scope.byTool[tool] = scope.byTool[tool] ?? { calls: 0, tokensSaved: 0 };
    scope.byTool[tool].calls++;
    scope.byTool[tool].tokensSaved += saved;
  }
  const day = new Date().toISOString().slice(0, 10);
  data.lifetime.byDay = data.lifetime.byDay ?? {};
  data.lifetime.byDay[day] = data.lifetime.byDay[day] ?? { calls: 0, tokensSaved: 0 };
  data.lifetime.byDay[day].calls++;
  data.lifetime.byDay[day].tokensSaved += saved;
  await mkdir(dirname(STATS_PATH), { recursive: true });
  await writeFile(STATS_PATH, JSON.stringify(data, null, 2));
}

// ---------- safety ----------

function isPrivateHost(host: string): boolean {
  if (process.env.ASHLR_HTTP_ALLOW_PRIVATE === "1") return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [parseInt(v4[1]!, 10), parseInt(v4[2]!, 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

// ---------- compressors ----------

function compressHtml(raw: string): string {
  let s = raw;
  // Strip block-level noise
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  s = s.replace(/<(nav|footer|aside|header|form)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Prefer <main> / <article> content when present
  const mainMatch = s.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (mainMatch) s = mainMatch[2]!;
  // Preserve structure, drop tags
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, t) => "\n" + "#".repeat(+lvl) + " " + stripTags(t) + "\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => "• " + stripTags(t) + "\n");
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => stripTags(t) + ` (${href})`);
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => "\n```\n" + decodeEntities(stripTags(t)) + "\n```\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => "`" + stripTags(t) + "`");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<p[^>]*>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function compressJson(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    return JSON.stringify(elideLongArrays(obj), null, 2);
  } catch {
    return raw;
  }
}

function elideLongArrays(v: any): any {
  if (Array.isArray(v)) {
    if (v.length > 20) {
      const head = v.slice(0, 10).map(elideLongArrays);
      const tail = v.slice(-5).map(elideLongArrays);
      return [...head, `[... ${v.length - 15} elided ...]`, ...tail];
    }
    return v.map(elideLongArrays);
  }
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && val.length > 300) {
        o[k] = val.slice(0, 280) + "…";
      } else {
        o[k] = elideLongArrays(val);
      }
    }
    return o;
  }
  return v;
}

// ---------- fetch ----------

interface HttpArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  mode?: "readable" | "raw" | "json" | "headers";
  maxBytes?: number;
  timeoutMs?: number;
}

async function doFetch(args: HttpArgs): Promise<string> {
  const { url, method = "GET", headers = {}, body, mode: reqMode, maxBytes = 2_000_000, timeoutMs = 15_000 } = args;

  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported scheme: ${parsed.protocol} (http/https only)`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`refusing private host ${parsed.hostname}; set ASHLR_HTTP_ALLOW_PRIVATE=1 to override`);
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "user-agent": "ashlr-plugin/0.5.0 (+https://plugin.ashlr.ai)", ...headers },
      body,
      redirect: "follow",
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    throw new Error(`fetch failed: ${(err as Error).message}`);
  }
  clearTimeout(t);

  const ct = res.headers.get("content-type") ?? "";

  if (reqMode === "headers") {
    const wanted = ["content-type", "content-length", "etag", "last-modified", "location", "cache-control"];
    const lines = [`${method} ${url} · ${res.status}`];
    for (const h of wanted) {
      const v = res.headers.get(h);
      if (v) lines.push(`  ${h}: ${v}`);
    }
    await recordSaving(2000, lines.join("\n").length, "ashlr__http");
    return lines.join("\n");
  }

  const buf = await res.arrayBuffer();
  const raw = new TextDecoder().decode(buf.slice(0, maxBytes));

  let compact: string;
  const mode = reqMode ?? (ct.includes("json") ? "json" : ct.includes("html") ? "readable" : "raw");
  switch (mode) {
    case "readable": compact = compressHtml(raw); break;
    case "json":     compact = compressJson(raw); break;
    case "raw":      compact = raw; break;
    default:         compact = raw;
  }

  await recordSaving(raw.length, compact.length, "ashlr__http");

  const header = `${method} ${url} · ${res.status} · ${ct || "?"} · ${(raw.length / 1024).toFixed(1)} KB → ${(compact.length / 1024).toFixed(1)} KB`;
  return header + "\n\n" + compact;
}

// ---------- MCP wiring ----------

const server = new Server(
  { name: "ashlr-http", version: "0.5.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "ashlr__http",
    description: "HTTP fetch with compressed output. Readable-extracts main content from HTML, pretty-prints + array-elides JSON, bounded byte cap. Refuses non-http/https schemes and private hosts by default.",
    inputSchema: {
      type: "object",
      properties: {
        url:       { type: "string" },
        method:    { type: "string", description: "HTTP method (default GET)" },
        headers:   { type: "object", description: "Request headers" },
        body:      { type: "string", description: "Request body for POST/PUT" },
        mode:      { type: "string", description: "'readable' (HTML→main content) | 'raw' | 'json' | 'headers'" },
        maxBytes:  { type: "number", description: "Response body cap before compression (default 2_000_000)" },
        timeoutMs: { type: "number", description: "Request timeout (default 15000)" },
      },
      required: ["url"],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "ashlr__http") {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  try {
    const text = await doFetch(req.params.arguments as unknown as HttpArgs);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ashlr__http error: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
