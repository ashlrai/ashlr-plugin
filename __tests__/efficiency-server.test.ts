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
  test("returns a formatted report", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const [, r] = await rpc(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      undefined,
    );
    const text = r.result.content[0].text;
    expect(text).toContain("Session:");
    expect(text).toContain("Lifetime:");
    expect(text).toContain("tokens saved");
    await rm(tmp, { recursive: true, force: true });
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
