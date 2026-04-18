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
import { recordSaving as recordSavingCore } from "./_stats";
import { confidenceBadge, confidenceTier } from "./_summarize";
import { logEvent } from "./_events";
export { isPrivateHost, compressHtml, compressJson } from "./_http-helpers";
import { compressHtml, compressJson, safeFetch } from "./_http-helpers";

async function recordSaving(raw: number, compact: number, tool: string): Promise<void> {
  await recordSavingCore(raw, compact, tool);
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

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    // safeFetch handles URL validation + scheme + isPrivateHost + SSRF-safe
    // manual redirect validation (each hop re-checked against isPrivateHost).
    res = await safeFetch(url, {
      method,
      headers: { "user-agent": "ashlr-plugin/0.9.2 (+https://plugin.ashlr.ai)", ...headers },
      body,
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
  const httpBadgeOpts = {
    toolName: "ashlr__http",
    rawBytes: raw.length,
    outputBytes: compact.length,
  };
  if (confidenceTier(httpBadgeOpts) === "low") {
    await logEvent("tool_noop", { tool: "ashlr__http", reason: "low-confidence" });
  }
  return header + "\n\n" + compact + confidenceBadge(httpBadgeOpts);
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
