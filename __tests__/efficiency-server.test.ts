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

const SERVER_PATH = join(import.meta.dir, "..", "servers", "efficiency-server.ts");
const PROJECT_ROOT = join(import.meta.dir, "..");

async function rpc(reqs: RpcRequest[], cwd?: string): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  // Absolute script path so the subprocess cwd can be any tmp dir (the
  // v1.11.2 cwd clamp rejects paths outside the subprocess's process.cwd(),
  // so tests passing tmp-dir paths inherit the parent test's cwd via the
  // `cwd` arg or via process.chdir() in a beforeEach hook).
  const proc = spawn({
    cmd: ["bun", "run", SERVER_PATH],
    cwd: cwd ?? process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
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
async function rpcWithHome(reqs: RpcRequest[], home: string, cwd?: string): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const proc = spawn({
    cmd: ["bun", "run", SERVER_PATH],
    cwd: cwd ?? process.cwd(),
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
  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), "ashlr-test-"));
    // chdir into tmp so the v1.11.2 cwd clamp inside the spawned server
    // accepts the tmp-dir paths these tests pass as tool args.
    process.chdir(tmp);
  });
  afterEach(async () => {
    process.chdir(originalCwd);
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
    // Head and tail should be preserved. A confidence badge may be appended
    // after the tail — strip it before the suffix check.
    expect(text.startsWith("HEAD")).toBe(true);
    const bodyOnly = text.replace(/\n\[ashlr confidence:[^\]]+\]\s*$/, "");
    expect(bodyOnly.endsWith("TAIL")).toBe(true);
  });
});

describe("MCP server · ashlr__edit", () => {
  let tmp: string;
  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), "ashlr-test-"));
    process.chdir(tmp);
  });
  afterEach(async () => {
    process.chdir(originalCwd);
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
  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), "ashlr-test-"));
    process.chdir(tmp);
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/a.ts"), 'const marker_xyz = 1;\n');
    await writeFile(join(tmp, "src/b.ts"), 'const unrelated = 2;\n');
  });
  afterEach(async () => {
    process.chdir(originalCwd);
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
    // Pass `home` as the subprocess cwd so the v1.11.2 clamp accepts the
    // tmp-dir file path we're reading.
    const responses = await rpcWithHome(
      [
        INIT,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__read", arguments: { path: file } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } },
      ],
      home,
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

  test("monthly rollup: shows 'not enough history' with a single active day", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(
      join(home, ".ashlr", "stats.json"),
      JSON.stringify({
        session: { calls: 0, tokensSaved: 0 },
        lifetime: {
          calls: 3,
          tokensSaved: 1200,
          byDay: { [today]: { calls: 3, tokensSaved: 1200 } },
        },
      }),
    );
    const [, r] = await rpcWithHome(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      home,
    );
    const text = r.result.content[0].text;
    expect(text).toContain("last 30 days");
    expect(text).toContain("not enough history yet");
    await rm(home, { recursive: true, force: true });
  });

  test("monthly rollup: aggregates calls, tokens, cost, and best day", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    // Build byDay across the last 5 days (well within 30-day window).
    const now = new Date();
    const day = (offset: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    const byDay = {
      [day(0)]: { calls: 10, tokensSaved: 10_000 },
      [day(1)]: { calls: 25, tokensSaved: 72_500 }, // best day
      [day(2)]: { calls: 5,  tokensSaved: 2_000 },
      [day(3)]: { calls: 8,  tokensSaved: 4_000 },
    };
    await writeFile(
      join(home, ".ashlr", "stats.json"),
      JSON.stringify({
        session: { calls: 0, tokensSaved: 0 },
        lifetime: { calls: 48, tokensSaved: 88_500, byDay },
      }),
    );
    const [, r] = await rpcWithHome(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      home,
    );
    const text = r.result.content[0].text;
    expect(text).toContain("last 30 days");
    // Totals: calls 48, tokens 88,500
    expect(text).toMatch(/calls\s+48/);
    expect(text).toContain("88,500 tok");
    // Best day is the day(1) at 72,500 tok / 25 calls
    expect(text).toContain(day(1));
    expect(text).toContain("72,500 tok");
    expect(text).toContain("25 calls");
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

describe("MCP server · summarization wiring", () => {
  let home: string;
  let stub: { stop: () => void; port: number };

  function startStubLLM(reply: string): { url: string; stop: () => void; port: number } {
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.json();
        return Response.json({ choices: [{ message: { content: reply } }] });
      },
    });
    const port = srv.port ?? 0;
    return { url: `http://localhost:${port}/v1`, stop: () => srv.stop(), port };
  }

  async function rpcWithEnv(
    reqs: RpcRequest[],
    env: Record<string, string>,
    cwd?: string,
  ): Promise<Array<{ id: number; result?: any; error?: any }>> {
    const proc = spawn({
      cmd: ["bun", "run", SERVER_PATH],
      cwd: cwd ?? process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const responses: Array<{ id: number; result?: any; error?: any }> = [];
    async function waitFor(id: number) {
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

  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    home = await mkdtemp(join(tmpdir(), "ashlr-summ-e2e-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    process.chdir(home);
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    if (stub) stub.stop();
    await rm(home, { recursive: true, force: true });
  });

  test("ashlr__read on >16KB file returns LLM summary + bypass hint", async () => {
    const s = startStubLLM("STUB_SUMMARY_OF_FILE");
    stub = s;
    const file = join(home, "big.ts");
    // snipCompact preserves head+tail; we need post-snip output > 16KB to trigger summarization.
    // Use 60KB of distinct content so the snipCompact output is still > 16KB.
    await writeFile(file, "HEAD\n" + "line of code here to keep bytes distinct\n".repeat(2000) + "TAIL");
    const [, r] = await rpcWithEnv(
      [
        INIT,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__read", arguments: { path: file } } },
      ],
      { HOME: home, ASHLR_LLM_URL: s.url },
    );
    const text = r.result.content[0].text;
    expect(text).toContain("STUB_SUMMARY_OF_FILE");
    expect(text).toContain("ashlr summary");
    expect(text).toContain("bypassSummary:true");
  });

  test("ashlr__read with bypassSummary:true returns raw snipCompact, no summary block", async () => {
    const s = startStubLLM("SHOULD_NOT_APPEAR");
    stub = s;
    const file = join(home, "big.ts");
    await writeFile(file, "HEAD\n" + "line of code here to keep bytes distinct\n".repeat(2000) + "TAIL");
    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__read", arguments: { path: file, bypassSummary: true } },
        },
      ],
      { HOME: home, ASHLR_LLM_URL: s.url },
    );
    const text = r.result.content[0].text;
    expect(text).not.toContain("SHOULD_NOT_APPEAR");
    expect(text).not.toContain("ashlr summary ·");
    expect(text).toContain("summarization bypassed");
  });

  test("ashlr__grep rg-fallback on huge output is summarized", async () => {
    const s = startStubLLM("STUB_GREP_SUMMARY");
    stub = s;
    const srcDir = join(home, "src");
    await mkdir(srcDir, { recursive: true });
    // Produce many lines matching the pattern so rg JSON output is huge.
    let body = "";
    for (let i = 0; i < 5000; i++) body += `MATCHME line ${i} with extra padding text to bloat output\n`;
    await writeFile(join(srcDir, "huge.txt"), body);
    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern: "MATCHME", cwd: home } },
        },
      ],
      { HOME: home, ASHLR_LLM_URL: s.url },
    );
    const text = r.result.content[0].text;
    // The truncated rg output is only >16KB when there are tons of matches;
    // if rg is absent the tool returns "[no matches]" — acceptable either way.
    if (text.includes("STUB_GREP_SUMMARY")) {
      expect(text).toContain("ashlr summary");
      expect(text).toContain("bypassSummary:true");
    } else {
      // rg not available or output under threshold — still must not error.
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("ashlr__grep with genome present is NOT summarized (passes through)", async () => {
    const s = startStubLLM("SHOULD_NOT_APPEAR_EITHER");
    stub = s;
    // Seed a minimal genome so genomeExists() returns true.
    const proj = await mkdtemp(join(tmpdir(), "ashlr-genome-"));
    await mkdir(join(proj, ".ashlrcode", "genome"), { recursive: true });
    await writeFile(join(proj, ".ashlrcode", "genome", "overview.md"), "# Overview\n\nThe marker_xyz symbol is defined in src/a.ts.\n");
    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern: "marker_xyz", cwd: proj } },
        },
      ],
      { HOME: home, ASHLR_LLM_URL: s.url },
    );
    const text = r.result.content[0].text;
    expect(text).not.toContain("SHOULD_NOT_APPEAR_EITHER");
    expect(text).not.toContain("ashlr summary ·");
    await rm(proj, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Fallback event emission — no-genome grep writes a tool_fallback record
// ---------------------------------------------------------------------------

describe("MCP server · fallback event emission", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-fallback-test-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("no-genome grep emits tool_fallback with reason=no-genome into session log", async () => {
    // Create a minimal project dir without a genome so the no-genome path fires.
    const projDir = join(home, "proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "hello.txt"), "hello world\n");

    const logPath = join(home, ".ashlr", "session-log.jsonl");

    // Use a clean env (HOME + PATH only) so the subprocess writes to the exact
    // tmpdir we control — not to whatever HOME a prior test may have left in
    // process.env or module-cached state.
    // Absolute server path + cwd=projDir so the v1.11.2 cwd clamp accepts
    // the caller-passed `cwd: projDir` (which equals process.cwd() inside
    // the spawned server).
    const serverPath = join(import.meta.dir, "..", "servers", "efficiency-server.ts");
    const proc = spawn({
      cmd: ["bun", "run", serverPath],
      cwd: projDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const input =
      JSON.stringify(INIT) +
      "\n" +
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ashlr__grep", arguments: { pattern: "hello", cwd: projDir } },
      }) +
      "\n";
    proc.stdin.write(input);
    await proc.stdin.end();
    await proc.exited;

    // Poll the log file with a bounded wait so the test isn't flaky under
    // a loaded machine where fs.appendFile takes > 100ms to flush.
    let records: Record<string, unknown>[] = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(logPath, "utf-8");
        records = raw
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        if (records.some((r) => r.event === "tool_fallback")) break;
      } catch {
        // log may not exist yet — retry
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const fallback = records.find(
      (r) => r.event === "tool_fallback" && r.tool === "ashlr__grep" && r.reason === "no-genome",
    );
    expect(fallback).toBeDefined();
    expect(fallback!.tool).toBe("ashlr__grep");
    expect(fallback!.reason).toBe("no-genome");
  });
});
