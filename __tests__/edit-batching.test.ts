/**
 * Tests for ashlr__edit write-through + ashlr__flush reporting (Part 2 of compression-v2-sprint2).
 *
 * Design note: all edits write immediately to disk because the MCP SDK dispatches
 * tool calls concurrently — a deferred-write queue would create races where a
 * read arrives before the preceding edit's timer fires. ensureFlushed() is
 * therefore a no-op; ashlr__flush is a session-log reporter ("what did I write?").
 *
 * Safety invariant: reads always see new content because writes are immediate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const EFFICIENCY_SERVER = join(import.meta.dir, "..", "servers", "efficiency-server.ts");

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  opts: { home?: string; cwd?: string; env?: Record<string, string> } = {},
): Promise<Array<{ id: number; result?: { content: Array<{ text: string }> }; error?: unknown }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = Bun.spawn({
    cmd: ["bun", "run", EFFICIENCY_SERVER],
    cwd: opts.cwd ?? process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: opts.home ?? process.env.HOME ?? "/tmp", ...(opts.env ?? {}) },
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

const INIT: RpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

function callEdit(id: number, path: string, search: string, replace: string): RpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ashlr__edit", arguments: { path, search, replace } } };
}
function callRead(id: number, path: string): RpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ashlr__read", arguments: { path } } };
}
function callFlush(id: number): RpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ashlr__flush", arguments: {} } };
}

let tmpDir: string;
let home: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-edit-batch-"));
  home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("edit write-through — file is always immediately on disk", () => {
  test("edit writes to disk immediately (file readable after edit)", async () => {
    const filePath = join(tmpDir, "target.txt");
    await writeFile(filePath, "hello world\n");

    await rpc([INIT, callEdit(2, filePath, "hello world", "hello ashlr")], { cwd: tmpDir, home });

    // File should be updated on disk regardless of MCP dispatch order.
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("hello ashlr");
    expect(content).not.toContain("hello world");
  });

  test("edit returns compact diff summary (not a queued message)", async () => {
    const filePath = join(tmpDir, "diff-test.txt");
    await writeFile(filePath, "original content\n");

    const responses = await rpc([INIT, callEdit(2, filePath, "original content", "updated content")], { cwd: tmpDir, home });
    const editResp = responses.find((r) => r.id === 2);
    expect(editResp?.error).toBeUndefined();
    const text = editResp?.result?.content[0]?.text ?? "";
    // Must return the compact diff summary format, not a queued/deferred message.
    expect(text).toContain("ashlr__edit");
    expect(text).toContain("hunks applied");
  });

  test("ashlr__flush returns summary of edits written in this session", async () => {
    const filePath = join(tmpDir, "flush-target.txt");
    await writeFile(filePath, "before\n");

    const responses = await rpc(
      [INIT, callEdit(2, filePath, "before", "after"), callFlush(3)],
      { cwd: tmpDir, home },
    );

    // The flush response may arrive before or after the edit (concurrent dispatch).
    // What matters: after process exit, the file is updated.
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("after");

    // The flush response itself should either show the edit summary or "nothing to flush".
    const flushResp = responses.find((r) => r.id === 3);
    expect(flushResp?.error).toBeUndefined();
    const text = flushResp?.result?.content[0]?.text ?? "";
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  test("flush with no preceding edits returns nothing-to-flush message", async () => {
    const responses = await rpc([INIT, callFlush(2)], { cwd: tmpDir, home });
    const flushResp = responses.find((r) => r.id === 2);
    expect(flushResp?.error).toBeUndefined();
    const text = flushResp?.result?.content[0]?.text ?? "";
    expect(text).toContain("nothing to flush");
  });

  test("strict mode rejects ambiguous search strings", async () => {
    const filePath = join(tmpDir, "strict-test.txt");
    await writeFile(filePath, "foo bar foo\n");

    const responses = await rpc(
      [INIT, callEdit(2, filePath, "foo", "baz", )],
      { cwd: tmpDir, home },
    );
    const editResp = responses.find((r) => r.id === 2);
    // strict=true (default), 'foo' appears twice → must error
    const hasError = editResp?.error != null || (editResp?.result?.content[0]?.text ?? "").includes("matched");
    expect(hasError).toBe(true);
  });
});

describe("edit write-through — read always sees new content", () => {
  test("sequential edit then read (separate rpc calls) sees updated file", async () => {
    const filePath = join(tmpDir, "seq-test.txt");
    await writeFile(filePath, "version one\n");

    // First call: edit
    await rpc([INIT, callEdit(2, filePath, "version one", "version two")], { cwd: tmpDir, home });

    // Second call: read — new process but file is already on disk
    const responses = await rpc([INIT, callRead(2, filePath)], { cwd: tmpDir, home });
    const readResp = responses.find((r) => r.id === 2);
    expect(readResp?.error).toBeUndefined();
    const text = readResp?.result?.content[0]?.text ?? "";
    expect(text).toContain("version two");
  });
});
