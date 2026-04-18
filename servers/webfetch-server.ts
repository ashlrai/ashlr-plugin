#!/usr/bin/env bun
/**
 * ashlr-webfetch MCP server — token-efficient article extraction.
 *
 * Narrowly focused: give it a URL, get the readable text the model would see
 * from native WebFetch, but aggressively compressed. HTML → title + main
 * content; JSON → pretty + array-elide; plain text → byte-capped passthrough.
 * Default cap: 100 KB (native WebFetch is uncapped).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { recordSaving } from "./_stats";
import { confidenceBadge, confidenceTier } from "./_summarize";
import { logEvent } from "./_events";
import { safeFetch, compressHtml, compressJson } from "./_http-helpers";

// ---------- types ----------

interface WebFetchArgs {
  url: string;
  prompt?: string;
  maxBytes?: number;
}

// ---------- text helpers ----------

function snipCompact(s: string, maxBytes: number): { text: string; snipped: boolean } {
  if (s.length <= maxBytes) return { text: s, snipped: false };
  const half = Math.floor(maxBytes / 2);
  const head = s.slice(0, half);
  const tail = s.slice(s.length - half);
  const elided = s.length - maxBytes;
  return {
    text: `${head}\n\n[... ${elided} bytes elided — use a larger maxBytes to see more ...]\n\n${tail}`,
    snipped: true,
  };
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// ---------- core ----------

async function doWebFetch(args: WebFetchArgs): Promise<string> {
  const { url, prompt, maxBytes = 100_000 } = args;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  let res: Response;
  try {
    // safeFetch handles URL validation + scheme check + isPrivateHost +
    // SSRF-safe manual redirect validation (each hop re-checked against
    // isPrivateHost so an attacker can't redirect us into 127.0.0.1).
    res = await safeFetch(url, {
      headers: { "user-agent": "ashlr-plugin/0.9.2 (+https://plugin.ashlr.ai)" },
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    throw new Error(`fetch failed: ${(err as Error).message}`);
  }
  clearTimeout(t);

  const ct = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  const rawText = new TextDecoder().decode(buf);
  const rawBytes = rawText.length;

  let extracted: string;
  let title: string | null = null;

  if (ct.includes("json")) {
    extracted = compressJson(rawText);
  } else if (
    ct.includes("html") ||
    ct.includes("xml") ||
    // Sniff: body starts with a tag AND the content-type isn't text/plain.
    // Parenthesized explicitly — without these parens, operator precedence
    // binds && tighter than ||, so binary/JS responses whose body happened
    // to start with `<` would get HTML-stripped.
    (!ct.includes("text/plain") && rawText.trimStart().startsWith("<"))
  ) {
    title = extractTitle(rawText);
    extracted = compressHtml(rawText);
  } else {
    // plain text or unknown — passthrough with cap
    extracted = rawText;
  }

  const { text: capped, snipped } = snipCompact(extracted, maxBytes);

  const lines: string[] = [];
  if (prompt) lines.push(`[webfetch · prompt: "${prompt}"]`);
  if (title) lines.push(`# ${title}\n`);
  lines.push(capped);
  if (snipped) {
    lines.push(`\n[content truncated at ${maxBytes} bytes — pass a larger maxBytes to see more]`);
  }

  const compactBytes = lines.join("\n").length;
  await recordSaving(rawBytes, compactBytes, "ashlr__webfetch");

  const ratio = rawBytes > 0 ? ((1 - compactBytes / rawBytes) * 100).toFixed(0) : "0";
  lines.push(
    `\n[ashlr__webfetch] URL: ${url} · raw: ${rawBytes}bytes · extracted: ${compactBytes}bytes · ${ratio}% reduction`,
  );

  const webBadgeOpts = {
    toolName: "ashlr__webfetch",
    rawBytes,
    outputBytes: compactBytes,
  };
  if (confidenceTier(webBadgeOpts) === "low") {
    await logEvent("tool_noop", { tool: "ashlr__webfetch", reason: "low-confidence" });
  }
  return lines.join("\n") + confidenceBadge(webBadgeOpts);
}

// ---------- MCP wiring ----------

const server = new Server(
  { name: "ashlr-webfetch", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "ashlr__webfetch",
    description:
      "Token-efficient URL fetcher. Aggressively extracts article text from HTML (title + main content, strips nav/scripts/styles), pretty-prints + array-elides JSON, byte-caps plain text. Default cap 100 KB vs native WebFetch which is uncapped. Use instead of WebFetch when you want article content — saves 60-95% tokens on typical pages.",
    inputSchema: {
      type: "object",
      properties: {
        url:      { type: "string", description: "URL to fetch (http/https only)" },
        prompt:   { type: "string", description: "What you're looking for — included as a hint in the output header" },
        maxBytes: { type: "number", description: "Max bytes of extracted text (default 100000)" },
      },
      required: ["url"],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "ashlr__webfetch") {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  try {
    const text = await doWebFetch(req.params.arguments as unknown as WebFetchArgs);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ashlr__webfetch error: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
