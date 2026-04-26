/**
 * webfetch-server-handlers — side-effect module.
 *
 * Importing this file registers the ashlr__webfetch tool into the shared
 * registry (_tool-base.ts). Used by both the standalone entry point
 * (webfetch-server.ts) and the router (_router.ts via _router-handlers.ts).
 *
 * Track D's LLM summarizer integration (summarizeIfLarge + recordSavingAccurate)
 * is preserved exactly as it exists in the original webfetch-server.ts.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { confidenceBadge, confidenceTier, summarizeIfLarge, PROMPTS } from "./_summarize";
import { recordSavingAccurate } from "./_accounting";
import { logEvent } from "./_events";
import { safeFetch, compressHtml, compressJson } from "./_http-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebFetchArgs {
  url: string;
  prompt?: string;
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

export async function doWebFetch(args: WebFetchArgs): Promise<string> {
  const { url, prompt, maxBytes = 100_000 } = args;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  let res: Response;
  try {
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
    (!ct.includes("text/plain") && rawText.trimStart().startsWith("<"))
  ) {
    title = extractTitle(rawText);
    extracted = compressHtml(rawText);
  } else {
    extracted = rawText;
  }

  // LLM summarization path (Track D): runs BEFORE the byte cap so
  // summarization can reduce truly large pages before we truncate as last resort.
  //
  // v1.18 (token-compression-wins): web content is denser than code — an
  // article, doc, or blog post just over 4 KB typically already contains a
  // dozen headings, paragraphs, and embedded links. Lowering the summarization
  // threshold from the default 16 KB to 4 KB captures the fat middle of
  // fetched pages without penalizing tiny responses (nav-only pages, quick
  // JSON blobs, 404s) that pass through unchanged.
  const WEBFETCH_SUMMARIZE_THRESHOLD_BYTES = 4 * 1024;
  const summResult = await summarizeIfLarge(extracted, {
    toolName: "ashlr__webfetch",
    systemPrompt: PROMPTS.webfetch,
    thresholdBytes: WEBFETCH_SUMMARIZE_THRESHOLD_BYTES,
  });
  const processedText = summResult.summarized || summResult.wasCached
    ? summResult.text
    : extracted;

  const { text: capped, snipped } = snipCompact(processedText, maxBytes);

  const lines: string[] = [];
  if (prompt) lines.push(`[webfetch · prompt: "${prompt}"]`);
  if (title) lines.push(`# ${title}\n`);
  lines.push(capped);
  if (snipped) {
    lines.push(`\n[content truncated at ${maxBytes} bytes — pass a larger maxBytes to see more]`);
  }

  const compactBytes = lines.join("\n").length;
  await recordSavingAccurate({
    rawBytes,
    compactBytes,
    toolName: "ashlr__webfetch",
    cacheHit: summResult.wasCached,
  });

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
    await logEvent("tool_low_confidence_shipped", { tool: "ashlr__webfetch", reason: "low-confidence" });
  }
  return lines.join("\n") + confidenceBadge(webBadgeOpts);
}

// ---------------------------------------------------------------------------
// Registration (side-effect on import)
// ---------------------------------------------------------------------------

registerTool({
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
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await doWebFetch(args as unknown as WebFetchArgs);
    return { content: [{ type: "text", text }] };
  },
});
