/**
 * End-to-end integration tests for the ashlr-glob MCP server.
 *
 * Spawns the real server, speaks JSON-RPC over stdio, asserts on responses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "bun";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  cwd?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  // Absolute server path so the spawn cwd can be anywhere. The v1.11.2
  // clamp reads process.cwd() in the spawned server; tests that exercise
  // tool calls against tmp dirs pass tmp as cwd so the user-supplied
  // `cwd: tmp` lands inside the working directory.
  const serverPath = join(import.meta.dir, "..", "servers", "glob-server.ts");
  const proc = spawn({
    cmd: ["bun", "run", serverPath],
    cwd: cwd ?? join(import.meta.dir, ".."),
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

function callGlob(id: number, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__glob", arguments: args },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe("ashlr-glob · bootstrap", () => {
  test("initialize + tools/list", async () => {
    const [init, list] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    expect(init.result).toMatchObject({
      serverInfo: { name: "ashlr-glob", version: "0.1.0" },
    });
    const tools = list.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toContain("ashlr__glob");
    expect(tools[0].description).toContain("token");
    expect(tools[0].inputSchema.required).toContain("pattern");
  });
});

// ---------------------------------------------------------------------------
// Simple pattern match (≤20 results)
// ---------------------------------------------------------------------------

describe("ashlr-glob · simple pattern match", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-glob-simple-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("matches *.ts files verbatim (≤20)", async () => {
    await writeFile(join(tmp, "a.ts"), "");
    await writeFile(join(tmp, "b.ts"), "");
    await writeFile(join(tmp, "c.js"), "");

    const [, r] = await rpc([INIT, callGlob(2, { pattern: "*.ts", cwd: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.js");
    // Footer present
    expect(text).toMatch(/\[ashlr__glob\] pattern ".*?" · 2 matches/);
  });

  test("empty result — no crash, zero-match footer", async () => {
    const [, r] = await rpc([INIT, callGlob(2, { pattern: "**/*.nonexistent", cwd: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;
    expect(text).toContain("0 matches");
  });

  test("nested pattern **/*.ts works", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), "");
    await writeFile(join(tmp, "root.ts"), "");
    await writeFile(join(tmp, "root.js"), "");

    const [, r] = await rpc([INIT, callGlob(2, { pattern: "**/*.ts", cwd: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;
    expect(text).toContain("root.ts");
    expect(text).toContain("foo.ts");
    expect(text).not.toContain("root.js");
  });
});

// ---------------------------------------------------------------------------
// >20 match grouping
// ---------------------------------------------------------------------------

describe("ashlr-glob · >20 match grouping", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-glob-large-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test(">20 matches grouped by top-level dir with counts", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "lib"), { recursive: true });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 15; i++) writes.push(writeFile(join(tmp, "src", `f${i}.ts`), ""));
    for (let i = 0; i < 10; i++) writes.push(writeFile(join(tmp, "lib", `g${i}.ts`), ""));
    await Promise.all(writes);

    const [, r] = await rpc([INIT, callGlob(2, { pattern: "**/*.ts", cwd: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;

    // Should be grouped, not individual files
    expect(text).toMatch(/src\/ · \d+ files/);
    expect(text).toMatch(/lib\/ · \d+ files/);
    // Footer
    expect(text).toMatch(/\[ashlr__glob\] pattern ".*?" · 25 matches/);
  });

  test("limit caps total matches", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) writes.push(writeFile(join(tmp, "src", `f${i}.ts`), ""));
    await Promise.all(writes);

    const [, r] = await rpc([INIT, callGlob(2, { pattern: "**/*.ts", cwd: tmp, limit: 10 })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;
    expect(text).toMatch(/limit=10/);
    // Should have at most 10 matches
    const matchLine = text.split("\n").find((l) => l.includes("[ashlr__glob]"));
    expect(matchLine).toBeDefined();
    const m = matchLine!.match(/· (\d+) matches/);
    expect(Number(m![1])).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// gitignore respect
// ---------------------------------------------------------------------------

describe("ashlr-glob · gitignore respect", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-glob-git-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("ignored file is skipped in a git repo", async () => {
    spawnSync({ cmd: ["git", "init", "-q"], cwd: tmp });
    spawnSync({ cmd: ["git", "config", "user.email", "t@t"], cwd: tmp });
    spawnSync({ cmd: ["git", "config", "user.name", "t"], cwd: tmp });

    await writeFile(join(tmp, ".gitignore"), "secret.ts\n");
    await writeFile(join(tmp, "visible.ts"), "");
    await writeFile(join(tmp, "secret.ts"), "shh");

    const [, r] = await rpc([INIT, callGlob(2, { pattern: "**/*.ts", cwd: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;
    expect(text).toContain("visible.ts");
    expect(text).not.toContain("secret.ts");
  });
});

// ---------------------------------------------------------------------------
// Savings recorded to stats.json
// ---------------------------------------------------------------------------

describe("ashlr-glob · savings accounting", () => {
  let tmp: string;
  let fakeHome: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-glob-stats-"));
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-glob-home-"));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("stats.json updated after a match", async () => {
    await writeFile(join(tmp, "foo.ts"), "");

    const serverPath = join(import.meta.dir, "..", "servers", "glob-server.ts");
    const proc = spawn({
      cmd: ["bun", "run", serverPath],
      cwd: tmp,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome },
    });

    const input = [
      JSON.stringify(INIT),
      JSON.stringify(callGlob(2, { pattern: "*.ts", cwd: tmp })),
    ].join("\n") + "\n";

    proc.stdin.write(input);
    await proc.stdin.end();
    await new Response(proc.stdout).text();
    await proc.exited;

    const statsPath = join(fakeHome, ".ashlr", "stats.json");
    expect(existsSync(statsPath)).toBe(true);
    const stats = JSON.parse(await readFile(statsPath, "utf-8"));
    // Has sessions field with at least one entry recording a call
    expect(stats.sessions).toBeDefined();
    const sessions = Object.values(stats.sessions) as any[];
    expect(sessions.length).toBeGreaterThan(0);
    // At least one session recorded a call from ashlr__glob
    const hasCall = sessions.some(
      (s) => (s.calls ?? 0) > 0 || (s.byTool?.["ashlr__glob"]?.calls ?? 0) > 0,
    );
    expect(hasCall).toBe(true);
  });
});
