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

const BASH_SERVER_PATH = join(import.meta.dir, "..", "servers", "bash-server.ts");

async function rpc(
  reqs: RpcRequest[],
  opts: { home?: string; cwd?: string } = {},
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", BASH_SERVER_PATH],
    cwd: opts.cwd ?? process.cwd(),
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
  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    repo = await mkdtemp(join(tmpdir(), "ashlr-repo-"));
    // Init a real git repo with mixed states.
    const sh = (c: string) => Bun.spawnSync({ cmd: ["sh", "-c", c], cwd: repo });
    sh("git init -q && git config user.email t@t && git config user.name t");
    sh("echo a > tracked.txt && git add tracked.txt && git commit -q -m init");
    sh("echo modified >> tracked.txt"); // M
    sh("echo new > untracked.txt");      // ??
    sh("echo added > added.txt && git add added.txt"); // A
    // v1.11.2 clamp: shell-cwd must live under process.cwd().
    process.chdir(repo);
  });
  afterEach(async () => {
    process.chdir(originalCwd);
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

// ---------------------------------------------------------------------------
// Persistent-server helper for tail-mode tests.
// The one-shot rpc() above closes stdin between calls, which terminates the
// server — fine for the original synchronous tools, but tail mode needs the
// spawned child procs to live across multiple RPCs. This helper keeps the
// server alive and lets you send framed JSON-RPC requests sequentially.
// ---------------------------------------------------------------------------

class PersistentServer {
  private proc: ReturnType<typeof spawn>;
  private buffer = "";
  private pending = new Map<number, (msg: any) => void>();
  private reader: Promise<void>;

  constructor(home: string, cwd?: string) {
    this.proc = spawn({
      cmd: ["bun", "run", BASH_SERVER_PATH],
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    this.reader = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const fn = this.pending.get(msg.id);
          if (fn) { this.pending.delete(msg.id); fn(msg); }
        } catch { /* ignore non-json */ }
      }
    }
  }

  send(req: RpcRequest): Promise<any> {
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      const stdin = this.proc.stdin as unknown as { write: (data: string) => void };
      stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async close(): Promise<void> {
    try {
      const stdin = this.proc.stdin as unknown as { end: () => unknown };
      await stdin.end();
    } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
    await this.proc.exited;
  }
}

function callNamed(id: number, name: string, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function text(r: any): string {
  return r.result.content[0].text as string;
}

describe("ashlr-bash · tail mode", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "ashlr-home-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("tools/list exposes the new tail-mode tools", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      const r = await s.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const names = r.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("ashlr__bash");
      expect(names).toContain("ashlr__bash_start");
      expect(names).toContain("ashlr__bash_tail");
      expect(names).toContain("ashlr__bash_stop");
      expect(names).toContain("ashlr__bash_list");
    } finally { await s.close(); }
  });

  test("start + tail + exit: seq output streams and reports final exit", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      // Cross-platform streaming command: bash-server spawns PowerShell on
      // Windows and $SHELL/sh on POSIX, so the script syntax must branch.
      const command = process.platform === "win32"
        ? "1..5 | ForEach-Object { Write-Output \"line-$_\"; Start-Sleep -Milliseconds 50 }"
        : "for i in 1 2 3 4 5; do echo line-$i; sleep 0.05; done";
      const startResp = await s.send(callNamed(2, "ashlr__bash_start", {
        command,
      }));
      const startTxt = text(startResp);
      expect(startTxt).toContain("[started]");
      const id = startTxt.match(/id=([a-f0-9]+)/)![1];

      // Poll repeatedly until we see the exit.
      let sawExit = false;
      let accumulated = "";
      for (let i = 0; i < 20 && !sawExit; i++) {
        const r = await s.send(callNamed(10 + i, "ashlr__bash_tail", { id, wait_ms: 500 }));
        const t = text(r);
        accumulated += t;
        if (/exit 0/.test(t)) sawExit = true;
      }
      expect(sawExit).toBe(true);
      expect(accumulated).toContain("line-1");
      expect(accumulated).toContain("line-5");
    } finally { await s.close(); }
  });

  test("tail with wait_ms: 0 returns immediately", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      const startResp = await s.send(callNamed(2, "ashlr__bash_start", {
        command: "sleep 5",
      }));
      const id = text(startResp).match(/id=([a-f0-9]+)/)![1];
      const t0 = Date.now();
      const r = await s.send(callNamed(3, "ashlr__bash_tail", { id, wait_ms: 0 }));
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(400);
      expect(text(r)).toContain("running");
      await s.send(callNamed(4, "ashlr__bash_stop", { id }));
    } finally { await s.close(); }
  });

  test("tail with wait_ms blocks until new output arrives", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      const startResp = await s.send(callNamed(2, "ashlr__bash_start", {
        command: "sleep 0.3 && echo hi-there",
      }));
      const id = text(startResp).match(/id=([a-f0-9]+)/)![1];
      // Drain the initial "no new output" state.
      await s.send(callNamed(3, "ashlr__bash_tail", { id, wait_ms: 0 }));
      const t0 = Date.now();
      const r = await s.send(callNamed(4, "ashlr__bash_tail", { id, wait_ms: 2000 }));
      const elapsed = Date.now() - t0;
      const txt = text(r);
      expect(txt).toContain("hi-there");
      // Should have returned shortly after the echo, not hung the full 2s.
      expect(elapsed).toBeLessThan(1800);
      expect(elapsed).toBeGreaterThan(100);
    } finally { await s.close(); }
  });

  test("stop terminates a hung process", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      const startResp = await s.send(callNamed(2, "ashlr__bash_start", {
        command: "sleep 30",
      }));
      const id = text(startResp).match(/id=([a-f0-9]+)/)![1];
      const stopResp = await s.send(callNamed(3, "ashlr__bash_stop", { id }));
      const t = text(stopResp);
      expect(t).toContain("stopped");
      expect(t).toContain(id);
    } finally { await s.close(); }
  });

  test("list returns current sessions", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      const r1 = await s.send(callNamed(2, "ashlr__bash_start", { command: "sleep 5" }));
      const id = text(r1).match(/id=([a-f0-9]+)/)![1];
      const r2 = await s.send(callNamed(3, "ashlr__bash_list", {}));
      const t = text(r2);
      expect(t).toContain(id);
      expect(t).toContain("sleep 5");
      await s.send(callNamed(4, "ashlr__bash_stop", { id }));
    } finally { await s.close(); }
  });

  test("session state persists across a server restart (dead-PID pruning)", async () => {
    // 1. Start a server, spawn a short-lived session, let it exit.
    const s1 = new PersistentServer(home);
    await s1.send(INIT);
    const r1 = await s1.send(callNamed(2, "ashlr__bash_start", { command: "echo gone" }));
    const id1 = text(r1).match(/id=([a-f0-9]+)/)![1];
    // Drain to let the child exit and be cleaned up (tail removes exited sessions).
    for (let i = 0; i < 5; i++) {
      const r = await s1.send(callNamed(10 + i, "ashlr__bash_tail", { id: id1, wait_ms: 300 }));
      if (/exit 0/.test(text(r))) break;
    }
    // 2. Start another session and leave it running. Close server before it exits.
    const r2 = await s1.send(callNamed(20, "ashlr__bash_start", { command: "sleep 10" }));
    const id2 = text(r2).match(/id=([a-f0-9]+)/)![1];
    // Read persisted state from disk.
    const persisted = JSON.parse(
      await readFile(join(home, ".ashlr", "bash-sessions.json"), "utf-8"),
    );
    expect(Array.isArray(persisted)).toBe(true);
    const ids = persisted.map((p: any) => p.id);
    expect(ids).toContain(id2);
    const persistedEntry = persisted.find((p: any) => p.id === id2);
    expect(persistedEntry.command).toBe("sleep 10");
    expect(typeof persistedEntry.pid).toBe("number");

    // Kill the child before closing the server so no zombie is left around.
    try { process.kill(persistedEntry.pid, "SIGKILL"); } catch { /* ignore */ }
    await s1.close();

    // 3. Start a fresh server with same HOME — it should reload live PIDs,
    //    prune dead ones. Since we SIGKILL'd the child, it should be gone.
    const s2 = new PersistentServer(home);
    try {
      await s2.send(INIT);
      const listResp = await s2.send(callNamed(2, "ashlr__bash_list", {}));
      const t = text(listResp);
      // Dead PID pruned.
      expect(t).not.toContain(id2);
    } finally { await s2.close(); }
  });

  test("stderr passes through in tail output", async () => {
    const s = new PersistentServer(home);
    try {
      await s.send(INIT);
      const startResp = await s.send(callNamed(2, "ashlr__bash_start", {
        command: "echo oops 1>&2; exit 3",
      }));
      const id = text(startResp).match(/id=([a-f0-9]+)/)![1];
      let txt = "";
      for (let i = 0; i < 10; i++) {
        const r = await s.send(callNamed(10 + i, "ashlr__bash_tail", { id, wait_ms: 400 }));
        txt += text(r);
        if (/exit 3/.test(text(r))) break;
      }
      expect(txt).toContain("oops");
      expect(txt).toContain("exit 3");
    } finally { await s.close(); }
  });
});

function startStubLLM(reply: string): { url: string; stop: () => void } {
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.json();
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  });
  return { url: `http://localhost:${srv.port}/v1`, stop: () => srv.stop() };
}

describe("ashlr-bash · LLM summarization", () => {
  test("long stdout > 16KB routes through LLM summarizer", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const stub = startStubLLM("STUB_BASH_SUMMARY_42");
    try {
      // 20_000 bytes of 'a' — over the 16KB summarize threshold, not a recognized command.
      const cmd = `head -c 20000 /dev/zero | tr '\\0' 'a'`;
      const proc = spawn({
        cmd: ["bun", "run", BASH_SERVER_PATH],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, ASHLR_LLM_URL: stub.url },
      });
      const input =
        JSON.stringify(INIT) + "\n" +
        JSON.stringify(call(2, { command: cmd })) + "\n";
      proc.stdin.write(input);
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      const r = lines[1];
      const text: string = r.result.content[0].text;
      expect(text).toContain("STUB_BASH_SUMMARY_42");
      expect(text).toContain("bypassSummary:true");
    } finally {
      stub.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("recognized-command git status is NOT re-summarized by LLM", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    // Work inside a git repo to exercise the structured summarizer path.
    const repo = await mkdtemp(join(tmpdir(), "ashlr-repo-"));
    const stub = startStubLLM("STUB_SHOULD_NOT_APPEAR");
    try {
      // Init a repo and create many untracked files so porcelain output > 16KB.
      const initScript = "git init -q && i=0; while [ $i -lt 500 ]; do : > \"longfilename_$i.txt\"; i=$((i+1)); done";
      const init = spawn({
        cmd: ["sh", "-c", initScript],
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      await init.exited;

      const serverPath = join(import.meta.dir, "..", "servers", "bash-server.ts");
      const proc = spawn({
        cmd: ["bun", "run", serverPath],
        cwd: repo,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, ASHLR_LLM_URL: stub.url },
      });
      const input =
        JSON.stringify(INIT) + "\n" +
        JSON.stringify(call(2, { command: "git status" })) + "\n";
      proc.stdin.write(input);
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      const text: string = lines[1].result.content[0].text;
      expect(text).not.toContain("STUB_SHOULD_NOT_APPEAR");
    } finally {
      stub.stop();
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
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
