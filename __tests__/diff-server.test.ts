/**
 * End-to-end integration tests for ashlr__diff.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "bun";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  _cwd?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", "servers/diff-server.ts"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  void _cwd;
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
    clientInfo: { name: "test", version: "1" },
  },
};

function callDiff(id: number, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__diff", arguments: args },
  };
}

function git(cwd: string, args: string[]): void {
  const res = spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(res.stderr)}`);
  }
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

describe("ashlr-diff · bootstrap", () => {
  test("initialize + tools/list", async () => {
    const [init, list] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    expect(init.result).toMatchObject({ serverInfo: { name: "ashlr-diff", version: "0.1.0" } });
    const tools = list.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["ashlr__diff"]);
    expect(tools[0].description.length).toBeGreaterThan(30);
  });
});

describe("ashlr-diff · behavior", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-diff-"));
    await initRepo(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("stat mode on a synthetic change returns file count", async () => {
    await writeFile(join(tmp, "a.ts"), "export const a = 1;\n");
    await writeFile(join(tmp, "b.ts"), "export const b = 2;\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-q", "-m", "add ab"]);
    await writeFile(join(tmp, "a.ts"), "export const a = 10;\nexport const c = 3;\n");
    git(tmp, ["add", "."]);
    const [, call] = await rpc(
      [INIT, callDiff(2, { ref: "staged", mode: "stat", cwd: tmp })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    expect(text).toContain("1 file");
    expect(text).toContain("a.ts");
    expect(text).toMatch(/\+\d+ -\d+/);
  });

  test("adaptive: large diff collapses to stat", async () => {
    // Make a HUGE change on a single file.
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await writeFile(join(tmp, "big.txt"), big);
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-q", "-m", "add big"]);
    const mutated = Array.from({ length: 2000 }, (_, i) => `mutated line ${i} extra content`).join("\n") + "\n";
    await writeFile(join(tmp, "big.txt"), mutated);
    const [, call] = await rpc(
      [INIT, callDiff(2, { ref: "working", cwd: tmp })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    expect(text).toContain("mode=stat");
    // Stat output should not contain hunk headers.
    expect(text).not.toContain("@@");
  });

  test("path filter limits to one file", async () => {
    await writeFile(join(tmp, "x.ts"), "x\n");
    await writeFile(join(tmp, "y.ts"), "y\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-q", "-m", "xy"]);
    await writeFile(join(tmp, "x.ts"), "xx\n");
    await writeFile(join(tmp, "y.ts"), "yy\n");
    const [, call] = await rpc(
      [INIT, callDiff(2, { ref: "working", path: "x.ts", mode: "stat", cwd: tmp })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    expect(text).toContain("x.ts");
    expect(text).not.toContain("y.ts");
  });

  test("ref: 'staged' uses --cached semantics", async () => {
    await writeFile(join(tmp, "s.ts"), "before\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-q", "-m", "s"]);
    // Stage an edit, but leave a working-tree edit after it.
    await writeFile(join(tmp, "s.ts"), "staged\n");
    git(tmp, ["add", "s.ts"]);
    await writeFile(join(tmp, "s.ts"), "working\n");
    const [, call] = await rpc(
      [INIT, callDiff(2, { ref: "staged", mode: "full", cwd: tmp })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    // Staged diff includes "staged" content, not "working".
    expect(text).toContain("staged");
    expect(text).not.toMatch(/^\+working$/m);
  });

  test("non-git dir yields a clean error", async () => {
    const bare = await mkdtemp(join(tmpdir(), "ashlr-nongit-"));
    try {
      const [, call] = await rpc([INIT, callDiff(2, { cwd: bare })], bare);
      const text: string = call.result.content[0].text;
      expect(call.result.isError).toBe(true);
      expect(text).toMatch(/not a git repository/i);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
