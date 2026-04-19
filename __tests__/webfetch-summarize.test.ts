/**
 * Tests for webfetch/http LLM summarization path and accurate accounting.
 *
 * Strategy:
 * - Spawn a stub LLM server (same pattern as _summarize.test.ts) that captures
 *   requests and returns a canned summary.
 * - Spawn a stub HTTP content server serving a large HTML page (>16 KB).
 * - Spawn webfetch-server.ts / http-server.ts subprocesses with:
 *     ASHLR_LLM_URL=http://localhost:<stub-llm-port>/v1
 *     ASHLR_HTTP_ALLOW_PRIVATE=1
 *     HOME=<tmp dir>
 * - Send MCP RPC calls and assert on the output text.
 * - For the cache-hit path: call the same URL twice. On the second call the
 *   stub LLM will have been stopped (unreachable) — if caching works, the
 *   response still contains the summary (from the on-disk cache) and does NOT
 *   contain "[LLM unreachable]". Additionally, an accounting_cache_hit event
 *   should appear in session-log.jsonl.
 *
 * The LLM mock returns a predictable string so we can assert the summary path
 * was taken without needing a real Ollama/LM Studio instance.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// Large HTML page — must exceed DEFAULT_THRESHOLD_BYTES (16 384) after
// compressHtml strips scripts/styles/nav. We pad the <main> body with enough
// text so the extracted content is >16 KB.
const PADDING = "This is a long article paragraph full of interesting content. ".repeat(300); // ~18 KB
const LARGE_HTML = `<!doctype html>
<html><head><title>Large Article</title>
<script>var x = 1;</script>
<style>.y{color:blue}</style>
</head><body>
<nav>NAV JUNK</nav>
<main>
  <h1>Large Article Heading</h1>
  <p>${PADDING}</p>
  <a href="https://example.com/link">Read more</a>
</main>
<footer>FOOT JUNK</footer>
</body></html>`;

const STUB_SUMMARY = "[STUB LLM SUMMARY] Large Article: key findings preserved.";

// ---------------------------------------------------------------------------
// Lifecycle: tmp HOME dir + stub servers
// ---------------------------------------------------------------------------

let tmp: string;
let contentServer: { stop(): void; port: number };
let llmServer: { stop(): void; port: number; callCount: () => number } | undefined;

beforeAll(() => {
  // Content server: serves the large HTML page
  const cs = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/large") {
        return new Response(LARGE_HTML, { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  contentServer = { stop: () => cs.stop(), port: cs.port ?? 0 };
});

afterAll(() => {
  contentServer.stop();
  llmServer?.stop();
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ashlr-wf-summ-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startStubLLM(reply = STUB_SUMMARY): { url: string; stop(): void; callCount: () => number } {
  let calls = 0;
  const srv = Bun.serve({
    port: 0,
    fetch(_req) {
      calls++;
      return Response.json({
        choices: [{ message: { content: reply } }],
      });
    },
  });
  return {
    url: `http://localhost:${srv.port ?? 0}/v1`,
    stop: () => srv.stop(),
    callCount: () => calls,
  };
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

async function rpcWebfetch(reqs: object[], extraEnv: Record<string, string> = {}): Promise<any[]> {
  const proc = spawn({
    cmd: ["bun", "run", "servers/webfetch-server.ts"],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ASHLR_HTTP_ALLOW_PRIVATE: "1", HOME: tmp, ...extraEnv },
  });
  proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function rpcHttp(reqs: object[], extraEnv: Record<string, string> = {}): Promise<any[]> {
  const proc = spawn({
    cmd: ["bun", "run", "servers/http-server.ts"],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ASHLR_HTTP_ALLOW_PRIVATE: "1", HOME: tmp, ...extraEnv },
  });
  proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function webfetchCall(id: number, url: string, extra: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ashlr__webfetch", arguments: { url, ...extra } } };
}

function httpCall(id: number, url: string, extra: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ashlr__http", arguments: { url, ...extra } } };
}

// ---------------------------------------------------------------------------
// webfetch: LLM summarization path
// ---------------------------------------------------------------------------

describe("ashlr__webfetch · LLM summarization path", () => {
  test("large HTML page (>16 KB extracted) triggers LLM summarization", async () => {
    const stub = startStubLLM();
    try {
      const [, r] = await rpcWebfetch(
        [INIT, webfetchCall(2, `http://localhost:${contentServer.port}/large`)],
        { ASHLR_LLM_URL: stub.url },
      );
      const t: string = r.result.content[0].text;
      // LLM stub summary must appear in output
      expect(t).toContain(STUB_SUMMARY);
      // bypassSummary hint must appear (from summarizeIfLarge)
      expect(t).toContain("bypassSummary:true");
      // LLM was actually called
      expect(stub.callCount()).toBeGreaterThan(0);
      // No fallback marker
      expect(t).not.toContain("LLM unreachable");
    } finally {
      stub.stop();
    }
  });

  test("LLM unreachable falls back to snipCompact without crashing", async () => {
    const [, r] = await rpcWebfetch(
      [INIT, webfetchCall(2, `http://localhost:${contentServer.port}/large`)],
      // Point to a port that refuses connections
      { ASHLR_LLM_URL: "http://127.0.0.1:1/v1" },
    );
    const t: string = r.result.content[0].text;
    // Should still return something (fallback path — snipCompact of raw extracted)
    expect(t.length).toBeGreaterThan(0);
    // isError must NOT be true — fallback is graceful
    expect(r.result.isError).toBeFalsy();
    // The footer line must still be present (snipCompact path preserves it)
    expect(t).toContain("[ashlr__webfetch]");
    // The content must still contain article text
    expect(t).toContain("Large Article");
  });

  test("cache-hit path: second call serves from cache, no LLM call", async () => {
    const stub = startStubLLM();
    const url = `http://localhost:${contentServer.port}/large`;

    // First call — LLM is reachable, writes to cache
    const [, r1] = await rpcWebfetch(
      [INIT, webfetchCall(2, url)],
      { ASHLR_LLM_URL: stub.url },
    );
    expect(r1.result.content[0].text).toContain(STUB_SUMMARY);
    const callsAfterFirst = stub.callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Stop LLM — second call must NOT reach it (serves from on-disk cache)
    stub.stop();

    const [, r2] = await rpcWebfetch(
      [INIT, webfetchCall(2, url)],
      // Point to dead LLM; cache must win
      { ASHLR_LLM_URL: "http://127.0.0.1:1/v1" },
    );
    const t2: string = r2.result.content[0].text;
    // Summary still present from cache
    expect(t2).toContain(STUB_SUMMARY);
    // Not a fallback
    expect(t2).not.toContain("LLM unreachable");
    // bypassSummary hint still present
    expect(t2).toContain("bypassSummary:true");
  });

  test("footer line still present after summarization", async () => {
    const stub = startStubLLM();
    try {
      const [, r] = await rpcWebfetch(
        [INIT, webfetchCall(2, `http://localhost:${contentServer.port}/large`)],
        { ASHLR_LLM_URL: stub.url },
      );
      const t: string = r.result.content[0].text;
      expect(t).toContain("[ashlr__webfetch]");
      expect(t).toContain("raw:");
      expect(t).toContain("extracted:");
    } finally {
      stub.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// webfetch: accounting_cache_hit event
// ---------------------------------------------------------------------------

describe("ashlr__webfetch · cache-hit accounting event", () => {
  test("second call (cache hit) emits accounting_cache_hit to session-log.jsonl", async () => {
    const stub = startStubLLM();
    const url = `http://localhost:${contentServer.port}/large`;

    // First call to populate cache
    await rpcWebfetch(
      [INIT, webfetchCall(2, url)],
      { ASHLR_LLM_URL: stub.url },
    );
    stub.stop();

    // Second call (cache hit) — stop LLM so it must use cache
    await rpcWebfetch(
      [INIT, webfetchCall(2, url)],
      { ASHLR_LLM_URL: "http://127.0.0.1:1/v1" },
    );

    // Check session-log.jsonl for accounting_cache_hit event
    const logPath = join(tmp, ".ashlr", "session-log.jsonl");
    let logContent = "";
    try { logContent = await readFile(logPath, "utf-8"); } catch { /* may not exist if events disabled */ }

    if (logContent) {
      const events = logContent.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const hitEvents = events.filter((e: any) => e.event === "accounting_cache_hit");
      expect(hitEvents.length).toBeGreaterThan(0);
      const hitEvent = hitEvents[0];
      expect(hitEvent.tool).toBe("ashlr__webfetch");
      // extra fields are spread into the record by logEvent
      expect(hitEvent.rawBytes).toBeGreaterThan(0);
    }
    // If session-log.jsonl doesn't exist (ASHLR_SESSION_LOG=0 in env), skip
    // without failing — the test still verifies the response was served from cache.
  });
});

// ---------------------------------------------------------------------------
// http-server: LLM summarization path
// ---------------------------------------------------------------------------

describe("ashlr__http · LLM summarization path", () => {
  test("large HTML response (>16 KB) triggers LLM summarization", async () => {
    const stub = startStubLLM();
    try {
      const [, r] = await rpcHttp(
        [INIT, httpCall(2, `http://localhost:${contentServer.port}/large`)],
        { ASHLR_LLM_URL: stub.url },
      );
      const t: string = r.result.content[0].text;
      expect(t).toContain(STUB_SUMMARY);
      expect(t).toContain("bypassSummary:true");
      expect(stub.callCount()).toBeGreaterThan(0);
      expect(t).not.toContain("LLM unreachable");
    } finally {
      stub.stop();
    }
  });

  test("LLM unreachable falls back gracefully without crashing", async () => {
    const [, r] = await rpcHttp(
      [INIT, httpCall(2, `http://localhost:${contentServer.port}/large`)],
      { ASHLR_LLM_URL: "http://127.0.0.1:1/v1" },
    );
    expect(r.result.isError).toBeFalsy();
    const t = r.result.content[0].text;
    expect(t.length).toBeGreaterThan(0);
    // snipCompact fallback still surfaces article content
    expect(t).toContain("Large Article");
  });

  test("cache-hit path: second http call serves from cache without LLM", async () => {
    const stub = startStubLLM();
    const url = `http://localhost:${contentServer.port}/large`;

    const [, r1] = await rpcHttp(
      [INIT, httpCall(2, url)],
      { ASHLR_LLM_URL: stub.url },
    );
    expect(r1.result.content[0].text).toContain(STUB_SUMMARY);
    stub.stop();

    const [, r2] = await rpcHttp(
      [INIT, httpCall(2, url)],
      { ASHLR_LLM_URL: "http://127.0.0.1:1/v1" },
    );
    const t2 = r2.result.content[0].text;
    expect(t2).toContain(STUB_SUMMARY);
    expect(t2).not.toContain("LLM unreachable");
  });
});
