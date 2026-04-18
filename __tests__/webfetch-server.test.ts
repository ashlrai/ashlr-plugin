/**
 * Tests for ashlr-webfetch MCP server.
 *
 * Network is never hit — tests override globalThis.fetch with a mock,
 * then import the server module's internal logic via a subprocess RPC call
 * that also has the mock injected, or via direct unit-level function tests
 * for the helper functions.
 *
 * Strategy:
 *   - Helper unit tests (compressHtml, compressJson, isPrivateHost): import
 *     directly from http-server.ts — already exported.
 *   - End-to-end tool tests: spawn the server, inject a mock HTTP server for
 *     responses (same pattern as http-server.test.ts), and set
 *     ASHLR_HTTP_ALLOW_PRIVATE=1.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { compressHtml, compressJson, isPrivateHost } from "../servers/_http-helpers";
import { _drainWrites } from "../servers/_stats";

// ---------------------------------------------------------------------------
// Helpers: unit tests (no network)
// ---------------------------------------------------------------------------

describe("isPrivateHost (reused from http-server)", () => {
  test("localhost is private", () => expect(isPrivateHost("localhost")).toBe(true));
  test("127.0.0.1 is private", () => expect(isPrivateHost("127.0.0.1")).toBe(true));
  test("192.168.1.1 is private", () => expect(isPrivateHost("192.168.1.1")).toBe(true));
  test("10.0.0.1 is private", () => expect(isPrivateHost("10.0.0.1")).toBe(true));
  test("example.com is not private", () => expect(isPrivateHost("example.com")).toBe(false));
  test("8.8.8.8 is not private", () => expect(isPrivateHost("8.8.8.8")).toBe(false));
});

describe("compressHtml (reused from http-server)", () => {
  test("strips script and style", () => {
    const html = `<html><head><script>bad()</script><style>.x{}</style></head><body><main><p>Hello world</p></main></body></html>`;
    const out = compressHtml(html);
    expect(out).not.toContain("bad()");
    expect(out).not.toContain(".x{}");
    expect(out).toContain("Hello world");
  });

  test("strips nav and footer", () => {
    const html = `<body><nav>NAV</nav><main><p>Content</p></main><footer>FOOT</footer></body>`;
    const out = compressHtml(html);
    expect(out).not.toContain("NAV");
    expect(out).not.toContain("FOOT");
    expect(out).toContain("Content");
  });

  test("renders headings as markdown", () => {
    const html = `<main><h1>Title</h1><h2>Sub</h2><p>body</p></main>`;
    const out = compressHtml(html);
    expect(out).toContain("# Title");
    expect(out).toContain("## Sub");
  });

  test("flattens links with href", () => {
    const html = `<main><a href="https://example.com">click</a></main>`;
    const out = compressHtml(html);
    expect(out).toContain("click (https://example.com)");
  });
});

describe("compressJson (reused from http-server)", () => {
  test("elides arrays > 20 items", () => {
    const obj = { items: Array.from({ length: 50 }, (_, i) => ({ id: i })) };
    const out = compressJson(JSON.stringify(obj));
    expect(out).toContain("elided");
    expect(out).toContain('"id": 0');
    expect(out).toContain('"id": 49');
  });

  test("small JSON is pretty-printed without elision", () => {
    const obj = { a: 1, b: [1, 2, 3] };
    const out = compressJson(JSON.stringify(obj));
    expect(out).toContain('"a": 1');
    expect(out).not.toContain("elided");
  });
});

// ---------------------------------------------------------------------------
// End-to-end MCP tests via subprocess RPC + mock HTTP server
// ---------------------------------------------------------------------------

let testServer: { stop(): void; port: number };

const HTML_PAGE = `<!doctype html>
<html><head><title>Test Article</title>
<script>var x = 1;</script>
<style>.y{color:blue}</style>
</head><body>
<nav>NAV JUNK</nav>
<main>
  <h1>Main Heading</h1>
  <p>This is the <a href="/about">article body</a>.</p>
  <pre>code block</pre>
</main>
<footer>FOOT JUNK</footer>
</body></html>`;

const JSON_BIG = JSON.stringify({ data: Array.from({ length: 40 }, (_, i) => ({ id: i, val: "x" })) });
const PLAIN_TEXT = "Hello plain world. ".repeat(10);

beforeAll(() => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/html")  return new Response(HTML_PAGE,   { headers: { "content-type": "text/html" } });
      if (path === "/json")  return new Response(JSON_BIG,    { headers: { "content-type": "application/json" } });
      if (path === "/text")  return new Response(PLAIN_TEXT,  { headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    },
  });
  testServer = { stop: () => srv.stop(), port: srv.port ?? 0 };
});

afterAll(() => testServer.stop());

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

async function rpc(reqs: object[]): Promise<any[]> {
  const proc = spawn({
    cmd: ["bun", "run", "servers/webfetch-server.ts"],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ASHLR_HTTP_ALLOW_PRIVATE: "1" },
  });
  proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function toolCall(id: number, args: object) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ashlr__webfetch", arguments: args } };
}

describe("ashlr__webfetch · MCP registration", () => {
  test("initialize + tools/list returns ashlr__webfetch", async () => {
    const [init, list] = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
    expect(init.result.serverInfo.name).toBe("ashlr-webfetch");
    expect(list.result.tools[0].name).toBe("ashlr__webfetch");
  });
});

describe("ashlr__webfetch · HTML extraction", () => {
  test("extracts title and main content, strips nav/footer/script/style", async () => {
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/html` })]);
    const t: string = r.result.content[0].text;
    expect(t).toContain("Test Article");
    expect(t).toContain("# Main Heading");
    expect(t).toContain("article body");
    expect(t).toContain("/about");
    expect(t).not.toContain("NAV JUNK");
    expect(t).not.toContain("FOOT JUNK");
    expect(t).not.toContain("var x");
    expect(t).not.toContain(".y{");
  });

  test("includes prompt hint when provided", async () => {
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/html`, prompt: "find the heading" })]);
    const t: string = r.result.content[0].text;
    expect(t).toContain('[webfetch · prompt: "find the heading"]');
  });

  test("footer line always present", async () => {
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/html` })]);
    const t: string = r.result.content[0].text;
    expect(t).toContain("[ashlr__webfetch]");
    expect(t).toContain("raw:");
    expect(t).toContain("extracted:");
    expect(t).toContain("reduction");
  });
});

describe("ashlr__webfetch · JSON", () => {
  test("pretty-prints and elides long arrays", async () => {
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/json` })]);
    const t: string = r.result.content[0].text;
    expect(t).toContain("elided");
    expect(t).toContain('"id": 0');
    expect(t).toContain('"id": 39');
  });
});

describe("ashlr__webfetch · plain text", () => {
  test("plain text passes through with footer", async () => {
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/text` })]);
    const t: string = r.result.content[0].text;
    expect(t).toContain("Hello plain world");
    expect(t).toContain("[ashlr__webfetch]");
  });

  test("maxBytes cap truncates and adds hint", async () => {
    const longText = "x".repeat(500);
    // Serve it via a different approach — reuse the test server by passing
    // a small maxBytes; the /text route returns ~190 bytes which fits, so use
    // the HTML page (>190 bytes extracted) with a very small maxBytes.
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/html`, maxBytes: 50 })]);
    const t: string = r.result.content[0].text;
    expect(t).toContain("elided");
  });
});

describe("ashlr__webfetch · safety", () => {
  test("private IP rejected without env override", async () => {
    const proc = spawn({
      cmd: ["bun", "run", "servers/webfetch-server.ts"],
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ASHLR_HTTP_ALLOW_PRIVATE: undefined } as any,
    });
    proc.stdin.write(
      JSON.stringify(INIT) + "\n" +
      JSON.stringify(toolCall(2, { url: "http://192.168.1.1/secret" })) + "\n",
    );
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const r = lines[1];
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("private host");
  });

  test("unsupported scheme rejected", async () => {
    const [, r] = await rpc([INIT, toolCall(2, { url: "file:///etc/passwd" })]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("unsupported scheme");
  });
});

describe("ashlr__webfetch · savings recorded", () => {
  test("savings are recorded (rawBytes > compactBytes for typical HTML)", async () => {
    // We can't easily inspect stats.json in a unit test, but we can verify the
    // footer ratio shows a positive reduction for the HTML page (raw > compact).
    const [, r] = await rpc([INIT, toolCall(2, { url: `http://localhost:${testServer.port}/html` })]);
    const t: string = r.result.content[0].text;
    // The footer line should show a non-zero % reduction
    const match = t.match(/(\d+)% reduction/);
    expect(match).not.toBeNull();
    const pct = parseInt(match![1]!, 10);
    expect(pct).toBeGreaterThan(0);
  });
});
