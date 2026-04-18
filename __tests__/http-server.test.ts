import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "bun";

let testServer: { stop(): void; port: number };

beforeAll(() => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/html") {
        return new Response(
          `<!doctype html>
<html><head><title>x</title>
<script>var bad = 1;</script>
<style>.bad{color:red}</style>
</head><body>
<nav>NAV JUNK</nav>
<main><h1>Hello</h1><p>This is the <a href="/link">main content</a>.</p>
<pre>const x = 42;</pre></main>
<footer>FOOTER JUNK</footer>
</body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname === "/json-small") {
        return new Response(JSON.stringify({ a: 1, b: [1, 2, 3] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/json-big") {
        return new Response(JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ id: i })) }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/hang") return new Promise(() => {}); // never resolves
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    },
  });
  testServer = { stop: () => srv.stop(), port: srv.port ?? 0 };
});
afterAll(() => testServer.stop());

async function rpc(reqs: object[]): Promise<any[]> {
  const proc = spawn({
    cmd: ["bun", "run", "servers/http-server.ts"],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ASHLR_HTTP_ALLOW_PRIVATE: "1" },
  });
  proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

describe("ashlr__http", () => {
  test("initialize + tools/list", async () => {
    const [init, list] = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
    expect(init.result.serverInfo.name).toBe("ashlr-http");
    expect(list.result.tools[0].name).toBe("ashlr__http");
  });

  test("HTML in readable mode strips script/style/nav/footer", async () => {
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__http", arguments: { url: `http://localhost:${testServer.port}/html` } } },
    ]);
    const t = r.result.content[0].text;
    expect(t).toContain("# Hello");
    expect(t).toContain("main content");
    expect(t).toContain("(/link)");
    expect(t).toContain("```");
    expect(t).not.toContain("NAV JUNK");
    expect(t).not.toContain("FOOTER JUNK");
    expect(t).not.toContain("var bad");
    expect(t).not.toContain(".bad");
  });

  test("JSON big: arrays over 20 items elide", async () => {
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__http", arguments: { url: `http://localhost:${testServer.port}/json-big` } } },
    ]);
    const t = r.result.content[0].text;
    expect(t).toContain("elided");
    expect(t).toContain('"id": 0');
    expect(t).toContain('"id": 99');
  });

  test("headers mode returns content-type only, no body", async () => {
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__http", arguments: { url: `http://localhost:${testServer.port}/html`, mode: "headers" } } },
    ]);
    const t = r.result.content[0].text;
    expect(t).toContain("200");
    expect(t).toContain("text/html");
    expect(t).not.toContain("Hello");
  });

  test("invalid scheme rejected", async () => {
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__http", arguments: { url: "file:///etc/passwd" } } },
    ]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("unsupported scheme");
  });
});

describe("ashlr__http · safety", () => {
  test("private host refused without env override", async () => {
    // Spawn without ASHLR_HTTP_ALLOW_PRIVATE
    const proc = spawn({
      cmd: ["bun", "run", "servers/http-server.ts"],
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ASHLR_HTTP_ALLOW_PRIVATE: undefined } as any,
    });
    proc.stdin.write(JSON.stringify(INIT) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__http", arguments: { url: "http://localhost:1234/" } } }) + "\n");
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const r = lines[1];
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("private host");
  });
});
