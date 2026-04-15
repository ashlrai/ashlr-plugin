/**
 * End-to-end integration tests for the ashlr-bash MCP server.
 *
 * Spawns the real server, speaks JSON-RPC over stdio, asserts on real
 * responses. HOME is redirected to a per-test tmpdir so stats accounting
 * stays isolated from the developer's real ~/.ashlr/stats.json.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
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
  opts: { home?: string; cwd?: string } = {},
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", "servers/bash-server.ts"],
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: opts.home ?? process.env.HOME },
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

function call(id: number, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__bash", arguments: args },
  };
}

describe("ashlr-bash · bootstrap", () => {
  test("tools/list exposes ashlr__bash", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    try {
      const [, r] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        { home },
      );
      const names = r.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("ashlr__bash");
      const t = r.result.tools[0];
      expect(t.inputSchema.required).toEqual(["command"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ashlr-bash · basic execution", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "ashlr-home-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("echo hello returns the literal string and exit 0", async () => {
    const [, r] = await rpc([INIT, call(2, { command: "echo hello" })], { home });
    const text: string = r.result.content[0].text;
    expect(text).toContain("$ echo hello");
    expect(text).toContain("hello");
    expect(text).toContain("exit 0");
  });

  test("non-zero exit reports the code; stderr passes through uncompressed", async () => {
    // sh -c forwarded; this writes to stderr and exits 7.
    const [, r] = await rpc(
      [INIT, call(2, { command: "echo boom 1>&2; exit 7" })],
      { home },
    );
    const text: string = r.result.content[0].text;
    expect(text).toContain("exit 7");
    expect(text).toContain("--- stderr ---");
    expect(text).toContain("boom");
  });
});

describe("ashlr-bash · compression", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "ashlr-home-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("10KB output is compressed with marker; head/tail preserved", async () => {
    // Use printf to emit a deterministic 10KB body with distinct head/tail
    // sentinels. printf is portable across bash and zsh.
    const cmd =
      `printf 'HEAD_SENTINEL'; head -c 10240 /dev/zero | tr '\\0' 'x'; printf 'TAIL_SENTINEL'`;
    const [, r] = await rpc([INIT, call(2, { command: cmd })], { home });
    const text: string = r.result.content[0].text;
    expect(text).toContain("bytes of output elided");
    expect(text).toContain("HEAD_SENTINEL");
    expect(text).toContain("TAIL_SENTINEL");
    expect(text).toContain("compact saved");
  });
});

describe("ashlr-bash · structured summaries", () => {
  let home: string;
  let repo: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    repo = await mkdtemp(join(tmpdir(), "ashlr-repo-"));
    // Init a real git repo with mixed states.
    const sh = (c: string) => Bun.spawnSync({ cmd: ["sh", "-c", c], cwd: repo });
    sh("git init -q && git config user.email t@t && git config user.name t");
    sh("echo a > tracked.txt && git add tracked.txt && git commit -q -m init");
    sh("echo modified >> tracked.txt"); // M
    sh("echo new > untracked.txt");      // ??
    sh("echo added > added.txt && git add added.txt"); // A
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  test("git status --porcelain emits structured summary", async () => {
    const [, r] = await rpc(
      [INIT, call(2, { command: "git status --porcelain", cwd: repo })],
      { home },
    );
    const text: string = r.result.content[0].text;
    // Should have counts for M, A, ??.
    expect(text).toMatch(/M:\s*1/);
    expect(text).toMatch(/A:\s*1/);
    expect(text).toMatch(/\?\?:\s*1/);
    expect(text).toContain("branch");
    expect(text).toContain("exit 0");
  });
});

describe("ashlr-bash · safety", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "ashlr-home-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("rm -rf / is refused without execution", async () => {
    const [, r] = await rpc([INIT, call(2, { command: "rm -rf /" })], { home });
    const text: string = r.result.content[0].text;
    expect(text).toContain("refused");
    expect(text).not.toContain("exit ");
  });

  test("cat <file> redirects to ashlr__read", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ashlr-cat-"));
    const path = join(tmp, "thing.txt");
    await writeFile(path, "irrelevant");
    try {
      const [, r] = await rpc([INIT, call(2, { command: `cat ${path}` })], { home });
      const text: string = r.result.content[0].text;
      expect(text).toContain("ashlr__read");
      expect(text).not.toContain("exit 0");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("timeout kills the process and reports it", async () => {
    const [, r] = await rpc(
      [INIT, call(2, { command: "sleep 5", timeout_ms: 300 })],
      { home },
    );
    const text: string = r.result.content[0].text;
    expect(text).toContain("timed out after 300ms");
  });
});

describe("ashlr-bash · savings accounting", () => {
  test("known-size compression bumps tokensSaved by the expected amount", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    try {
      // Produce ~10KB of non-summarizable output (a generic command, not git/ls/etc.)
      // 10240 'x' bytes plus a trailing newline from printf is 10241.
      const cmd = `head -c 10240 /dev/zero | tr '\\0' 'x'`;
      const [, r] = await rpc([INIT, call(2, { command: cmd })], { home });
      expect(r.result.isError).toBeUndefined();
      const stats = JSON.parse(
        await readFile(join(home, ".ashlr", "stats.json"), "utf-8"),
      );
      // Lifetime tokens saved should be > 0 and roughly (10240 - ~1666)/4.
      // We assert a generous lower bound to keep the test robust to head/tail
      // tweaks but still meaningfully verifying accounting.
      expect(stats.lifetime.tokensSaved).toBeGreaterThan(1500);
      expect(stats.lifetime.calls).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
