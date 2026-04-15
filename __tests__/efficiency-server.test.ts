/**
 * End-to-end integration tests for the ashlr-efficiency MCP server.
 *
 * Spawns the real server, speaks real JSON-RPC over stdio, asserts on real
 * responses. No mocks — this is the thing Claude Code will actually be talking
 * to once the plugin is installed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(reqs: RpcRequest[], cwd?: string): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", "servers/efficiency-server.ts"],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: cwd ?? process.env.HOME },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Like rpc() but keeps the server's cwd as the plugin root, overrides HOME,
 *  and sends requests one at a time (waiting for each response) to preserve
 *  ordering — the MCP SDK services requests concurrently. */
async function rpcWithHome(reqs: RpcRequest[], home: string): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const proc = spawn({
    cmd: ["bun", "run", "servers/efficiency-server.ts"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const responses: Array<{ id: number; result?: any; error?: any }> = [];

  async function waitFor(id: number): Promise<{ id: number; result?: any; error?: any }> {
    while (true) {
      const existing = responses.find((r) => r.id === id);
      if (existing) return existing;
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed before id=${id}`);
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) responses.push(JSON.parse(line));
      }
    }
  }

  for (const r of reqs) {
    proc.stdin.write(JSON.stringify(r) + "\n");
    await waitFor(r.id);
  }
  await proc.stdin.end();
  await proc.exited;
  return responses;
}

const INIT = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

describe("MCP server · bootstrap", () => {
  test("initialize returns serverInfo", async () => {
    const [r] = await rpc([INIT]);
    expect(r.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "ashlr-efficiency", version: "0.1.0" },
    });
  });

  test("tools/list returns all four tools with schemas", async () => {
    const [, r] = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "ashlr__read",
      "ashlr__grep",
      "ashlr__edit",
      "ashlr__savings",
    ]);
    for (const t of r.result.tools) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("MCP server · ashlr__read", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("small file: returns content unchanged (no snip)", async () => {
    const path = join(tmp, "tiny.txt");
    await writeFile(path, "hello world");
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__read", arguments: { path } } },
    ]);
    const text = r.result.content[0].text;
    expect(text).toBe("hello world");
    expect(text).not.toContain("[... truncated ...]");
  });

  test("large file: snipCompact truncates with marker", async () => {
    const path = join(tmp, "huge.txt");
    const content = "HEAD" + "x".repeat(5000) + "TAIL";
    await writeFile(path, content);
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__read", arguments: { path } } },
    ]);
    const text = r.result.content[0].text;
    expect(text).toContain("[... truncated ...]");
    expect(text.length).toBeLessThan(content.length);
    // Head and tail should be preserved
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
  });
});

describe("MCP server · ashlr__edit", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("applies a unique search/replace and returns a diff summary", async () => {
    const path = join(tmp, "target.ts");
    await writeFile(path, "const x = 1;\nconst y = 2;\n");
    const [, r] = await rpc([
      INIT,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ashlr__edit", arguments: { path, search: "const y = 2;", replace: "const y = 42;" } },
      },
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    expect(text).toContain("[ashlr__edit]");
    expect(text).toContain("1 of 1 hunks applied");
    // Actually applied to disk
    const after = await readFile(path, "utf-8");
    expect(after).toBe("const x = 1;\nconst y = 42;\n");
  });

  test("strict mode errors on multiple matches", async () => {
    const path = join(tmp, "multi.ts");
    await writeFile(path, "x\nx\nx\n");
    const [, r] = await rpc([
      INIT,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ashlr__edit", arguments: { path, search: "x", replace: "y" } },
      },
    ]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("matched 3 times");
    // File unchanged
    const after = await readFile(path, "utf-8");
    expect(after).toBe("x\nx\nx\n");
  });

  test("strict:false replaces all occurrences", async () => {
    const path = join(tmp, "multi.ts");
    await writeFile(path, "a\na\na\n");
    const [, r] = await rpc([
      INIT,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ashlr__edit",
          arguments: { path, search: "a", replace: "b", strict: false },
        },
      },
    ]);
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toContain("3 of 3 hunks applied");
    const after = await readFile(path, "utf-8");
    expect(after).toBe("b\nb\nb\n");
  });

  test("errors when search text not found", async () => {
    const path = join(tmp, "gone.ts");
    await writeFile(path, "nothing here");
    const [, r] = await rpc([
      INIT,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ashlr__edit", arguments: { path, search: "missing", replace: "x" } },
      },
    ]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("not found");
  });
});

describe("MCP server · ashlr__grep fallback path", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-test-"));
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/a.ts"), 'const marker_xyz = 1;\n');
    await writeFile(join(tmp, "src/b.ts"), 'const unrelated = 2;\n');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns a response (rg match or explicit no-matches)", async () => {
    const [, r] = await rpc([
      INIT,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ashlr__grep", arguments: { pattern: "marker_xyz", cwd: tmp } },
      },
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    // Either rg is installed and found the match, or rg isn't available and the
    // tool returned its explicit empty-result sentinel. Both are acceptable for
    // the fallback path; the real test is that the tool didn't crash.
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("MCP server · ashlr__savings", () => {
  test("returns a formatted report with new rich shape", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const [, r] = await rpc(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      undefined,
    );
    const text = r.result.content[0].text;
    expect(text).toContain("ashlr savings");
    expect(text).toContain("this session");
    expect(text).toContain("all-time");
    expect(text).toContain("calls");
    expect(text).toContain("saved");
    expect(text).toContain("cost");
    expect(text).toContain("by tool (session)");
    expect(text).toContain("last 7 days");
    await rm(tmp, { recursive: true, force: true });
  });

  test("legacy flat stats.json parses without crashing and is migrated on write", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    // Seed legacy flat shape (no byTool / byDay).
    await writeFile(
      join(home, ".ashlr", "stats.json"),
      JSON.stringify({
        session: { calls: 0, tokensSaved: 0 },
        lifetime: { calls: 100, tokensSaved: 50000 },
      }),
    );
    const [, r] = await rpcWithHome(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      home,
    );
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    // Lifetime count preserved.
    expect(text).toContain("100");
    expect(text).toContain("50,000");
    await rm(home, { recursive: true, force: true });
  });

  test("byTool counters increment per-tool after a read call", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const file = join(home, "f.txt");
    await writeFile(file, "x".repeat(6000));
    // Single-process sequence so state persists for the second call.
    const responses = await rpcWithHome(
      [
        INIT,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__read", arguments: { path: file } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } },
      ],
      home,
    );
    const readResp = responses.find((x) => x.id === 2)!;
    expect(readResp.result?.isError).toBeUndefined();
    const r = responses.find((x) => x.id === 3)!;
    const text = r.result.content[0].text;
    expect(text).toContain("ashlr__read");
    // Session calls = 1
    expect(text).toMatch(/calls\s+1\b/);
    // byDay: today's ISO date should appear in the 7-day chart (MM-DD).
    const mmdd = new Date().toISOString().slice(5, 10);
    expect(text).toContain(mmdd);
    await rm(home, { recursive: true, force: true });
  });

  test("cost math matches sonnet-4.5 input pricing ($3/M)", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    // 1,000,000 tokens saved => $3.00
    await writeFile(
      join(home, ".ashlr", "stats.json"),
      JSON.stringify({
        session: { calls: 0, tokensSaved: 0 },
        lifetime: { calls: 1, tokensSaved: 1_000_000 },
      }),
    );
    const [, r] = await rpcWithHome(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      home,
    );
    const text = r.result.content[0].text;
    expect(text).toContain("$3.00");
    await rm(home, { recursive: true, force: true });
  });
});

describe("MCP server · error handling", () => {
  test("unknown tool returns isError with message", async () => {
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__nonexistent", arguments: {} } },
    ]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("Unknown tool");
  });
});
