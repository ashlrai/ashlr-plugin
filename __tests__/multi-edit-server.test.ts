/**
 * Tests for ashlr-multi-edit MCP server.
 *
 * Covers: basic multi-file edits, atomicity (rollback on bad edit), file
 * coalescing (read/write once per path), strict-mode contract, savings
 * accounting, and MCP wiring (tools/list via stdio).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { _resetMemCache, _resetWriteCount, readStats, statsPath } from "../servers/_stats";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER = join(import.meta.dir, "..", "servers", "multi-edit-server.ts");

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/**
 * Spawn the server, send all requests at once, collect responses.
 * Uses a temp HOME so stats.json is isolated per test.
 */
async function rpc(
  reqs: RpcRequest[],
  home: string,
  cwd?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", SERVER],
    cwd: cwd ?? process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, ASHLR_STATS_SYNC: "1" },
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

function callMultiEdit(edits: unknown[], id = 1): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__multi_edit", arguments: { edits } },
  };
}

function listTools(id = 99): RpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/list" };
}

function initReq(id = 0): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.1" },
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let home: string;
let originalCwd: string;

beforeEach(async () => {
  process.env.ASHLR_STATS_SYNC = "1";
  originalCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-multi-edit-test-"));
  home = join(tmpDir, "home");
  await import("fs/promises").then((m) => m.mkdir(home, { recursive: true }));
  // chdir into tmpDir so the v1.11.2 clamp in ashlr__multi_edit accepts
  // the tmp-dir file paths these tests write edits to.
  process.chdir(tmpDir);
  _resetMemCache();
  _resetWriteCount();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.ASHLR_STATS_SYNC;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ashlr__multi_edit", () => {
  test("basic: 3 edits across 2 files — all applied, summary lists all", async () => {
    const fileA = join(tmpDir, "a.ts");
    const fileB = join(tmpDir, "b.ts");
    await writeFile(fileA, "const alpha = 1;\nconst beta = 2;\n");
    await writeFile(fileB, "export function hello() {}\n");

    const responses = await rpc(
      [
        initReq(),
        callMultiEdit([
          { path: fileA, search: "alpha", replace: "ALPHA" },
          { path: fileA, search: "beta", replace: "BETA" },
          { path: fileB, search: "hello", replace: "world" },
        ]),
      ],
      home,
    );

    const callRes = responses.find((r) => r.id === 1);
    expect(callRes?.error).toBeUndefined();
    const text: string = callRes?.result?.content?.[0]?.text ?? "";
    expect(text).toContain("applied 3 edits across 2 files");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");

    const contentsA = await readFile(fileA, "utf-8");
    const contentsB = await readFile(fileB, "utf-8");
    expect(contentsA).toContain("ALPHA");
    expect(contentsA).toContain("BETA");
    expect(contentsA).not.toContain("alpha");
    expect(contentsA).not.toContain("beta");
    expect(contentsB).toContain("world");
    expect(contentsB).not.toContain("hello");
  });

  test("atomicity: 2 good edits + 1 bad edit → NO file modified, error mentions failing edit", async () => {
    const fileA = join(tmpDir, "atomic-a.ts");
    const fileB = join(tmpDir, "atomic-b.ts");
    const originalA = "const x = 1;\n";
    const originalB = "const y = 2;\n";
    await writeFile(fileA, originalA);
    await writeFile(fileB, originalB);

    const responses = await rpc(
      [
        initReq(),
        callMultiEdit([
          { path: fileA, search: "const x", replace: "const X" },
          { path: fileB, search: "const y", replace: "const Y" },
          { path: fileA, search: "DOES_NOT_EXIST", replace: "whatever" },
        ]),
      ],
      home,
    );

    const callRes = responses.find((r) => r.id === 1);
    const text: string = callRes?.result?.content?.[0]?.text ?? "";

    // Should be an error response (isError:true) or the text should mention the failure.
    const isError = callRes?.result?.isError === true;
    expect(isError || text.includes("not found")).toBe(true);
    expect(text).toContain("edit[2]");

    // Files must be unmodified — the in-memory edits were never written.
    expect(await readFile(fileA, "utf-8")).toBe(originalA);
    expect(await readFile(fileB, "utf-8")).toBe(originalB);
  });

  test("coalescing: 5 edits on same file — summary shows file once, file reflects all changes", async () => {
    const fileA = join(tmpDir, "coalesce.ts");
    await writeFile(fileA, "a b c d e\n");

    const responses = await rpc(
      [
        initReq(),
        callMultiEdit([
          { path: fileA, search: "a", replace: "A" },
          { path: fileA, search: "b", replace: "B" },
          { path: fileA, search: "c", replace: "C" },
          { path: fileA, search: "d", replace: "D" },
          { path: fileA, search: "e", replace: "E" },
        ]),
      ],
      home,
    );

    const callRes = responses.find((r) => r.id === 1);
    expect(callRes?.error).toBeUndefined();
    const text: string = callRes?.result?.content?.[0]?.text ?? "";

    // 5 edits, 1 file
    expect(text).toContain("applied 5 edits across 1 file");

    const contents = await readFile(fileA, "utf-8");
    expect(contents).toBe("A B C D E\n");
  });

  test("strict contract: edit with strict=true matching 2 occurrences → error, nothing applied", async () => {
    const fileA = join(tmpDir, "strict.ts");
    const original = "foo bar foo\n";
    await writeFile(fileA, original);

    const responses = await rpc(
      [
        initReq(),
        callMultiEdit([
          { path: fileA, search: "foo", replace: "baz", strict: true },
        ]),
      ],
      home,
    );

    const callRes = responses.find((r) => r.id === 1);
    const text: string = callRes?.result?.content?.[0]?.text ?? "";
    expect(callRes?.result?.isError).toBe(true);
    expect(text).toMatch(/matched 2 times/);

    // File unchanged.
    expect(await readFile(fileA, "utf-8")).toBe(original);
  });

  test("savings: recordSaving fires with baseline > summary.length, entry in stats.json under byTool", async () => {
    const fileA = join(tmpDir, "savings.ts");
    // Large enough content so baseline clearly exceeds the summary length.
    const bigContent = "const " + "x".repeat(500) + " = 1;\n" + "const " + "y".repeat(500) + " = 2;\n";
    await writeFile(fileA, bigContent);

    const responses = await rpc(
      [
        initReq(),
        callMultiEdit([
          { path: fileA, search: "x".repeat(500), replace: "X".repeat(500) },
        ]),
      ],
      home,
    );

    const callRes = responses.find((r) => r.id === 1);
    expect(callRes?.error).toBeUndefined();
    expect(callRes?.result?.isError).toBeFalsy();

    // Read stats.json from the temp home.
    const statsFile = join(home, ".ashlr", "stats.json");
    // Give a brief moment for the sync write to land (ASHLR_STATS_SYNC=1 in
    // the spawned process writes synchronously, but we poll the file from our
    // process which has a different _pendingStats).
    const raw = await readFile(statsFile, "utf-8");
    const stats = JSON.parse(raw);

    const toolEntry = stats?.lifetime?.byTool?.["ashlr__multi_edit"];
    expect(toolEntry).toBeDefined();
    expect(toolEntry.calls).toBeGreaterThanOrEqual(1);
    expect(toolEntry.tokensSaved).toBeGreaterThan(0);
  });

  test("MCP wiring: tools/list returns ashlr__multi_edit", async () => {
    const responses = await rpc([initReq(), listTools()], home);
    const listRes = responses.find((r) => r.id === 99);
    expect(listRes?.error).toBeUndefined();
    const tools: Array<{ name: string }> = listRes?.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("ashlr__multi_edit");
  });
});
