/**
 * Router dispatch contract.
 *
 * Spawns `servers/_router.ts` as a standalone MCP stdio process, issues an
 * `initialize` + `tools/list` sequence, and asserts the full set of 27
 * ashlr tools is registered.
 *
 * Serves as the compile-time canary for the router migration: if a server's
 * handler module is removed from `_router-handlers.ts` or its `registerTool`
 * call regresses, this test catches it before any plugin.json entry breaks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

const ROUTER = resolve(__dirname, "..", "servers", "_router.ts");

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  home?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", ROUTER],
    cwd: resolve(__dirname, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: home ?? process.env.HOME ?? homedir(),
      ASHLR_STATS_SYNC: "1",
      ASHLR_SESSION_LOG: "0",
    },
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
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "router-dispatch-test", version: "1" },
  },
};

const EXPECTED_TOOLS = [
  // efficiency-server
  "ashlr__read",
  "ashlr__grep",
  "ashlr__edit",
  "ashlr__flush",
  "ashlr__savings",
  // bash-server
  "ashlr__bash",
  "ashlr__bash_start",
  "ashlr__bash_stop",
  "ashlr__bash_tail",
  "ashlr__bash_list",
  // fs/structure family (already migrated)
  "ashlr__glob",
  "ashlr__tree",
  "ashlr__ls",
  "ashlr__diff",
  "ashlr__webfetch",
  // diff-semantic
  "ashlr__diff_semantic",
  // ask + orient
  "ashlr__ask",
  "ashlr__orient",
  // http / logs / sql / multi-edit
  "ashlr__http",
  "ashlr__logs",
  "ashlr__sql",
  "ashlr__multi_edit",
  // github
  "ashlr__pr",
  "ashlr__issue",
  // genome (3)
  "ashlr__genome_propose",
  "ashlr__genome_consolidate",
  "ashlr__genome_status",
  // v1.13 AST rename
  "ashlr__edit_structural",
] as const;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-router-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("_router · tools/list dispatch", () => {
  test("returns the full ashlr tool set", async () => {
    const [, listResp] = await rpc(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
      home,
    );

    const tools: Array<{ name: string; description: string; inputSchema: unknown }> =
      listResp.result.tools;
    const names = new Set(tools.map((t) => t.name));

    for (const expected of EXPECTED_TOOLS) {
      expect(names.has(expected)).toBe(true);
    }
    // Exact-set guard: if someone adds a tool without extending this list, fail loudly.
    expect(tools.length).toBe(EXPECTED_TOOLS.length);
  });

  test("every registered tool has a non-empty description and object inputSchema", async () => {
    const [, listResp] = await rpc(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
      home,
    );

    const tools: Array<{ name: string; description: string; inputSchema: any }> =
      listResp.result.tools;
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema?.type).toBe("object");
    }
  });

  test("router init response identifies ashlr-router", async () => {
    const [init] = await rpc([INIT], home);
    expect(init.result).toMatchObject({ serverInfo: { name: "ashlr-router" } });
  });

  test("ASHLR_ROUTER_DISABLE=1 short-circuits cleanly (no tools/list response)", async () => {
    const proc = spawn({
      cmd: ["bun", "run", ROUTER],
      cwd: resolve(__dirname, ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_STATS_SYNC: "1",
        ASHLR_SESSION_LOG: "0",
        ASHLR_ROUTER_DISABLE: "1",
      },
    });
    proc.stdin.write(JSON.stringify(INIT) + "\n");
    await proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
