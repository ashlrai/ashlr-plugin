/**
 * Integration tests for the per-process read cache in ashlr__read.
 *
 * The cache lives inside the efficiency-server process as a module-level
 * Map keyed by absolute path. It isn't exported — which is the point, it's
 * a runtime behavior, not an API. So we exercise it by spawning one real
 * server process and sending multiple JSON-RPC requests on a single stdio
 * session. A second read of the same unchanged file must return a "(cached)"
 * prefix; a modified file must miss and re-read; bypassSummary must skip the
 * cache entirely.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SERVER_PATH = resolve(__dirname, "..", "..", "servers", "efficiency-server.ts");

interface RpcReq {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResp {
  id: number;
  result?: any;
  error?: any;
}

const INIT: RpcReq = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

/**
 * Run a sequence of JSON-RPC requests against ONE efficiency-server process.
 * Returns responses in request-order. Requests are dispatched one at a time
 * and we wait for each response before sending the next — the MCP SDK
 * services requests concurrently, and our cache tests need strict ordering.
 */
async function rpcSequenced(
  reqs: RpcReq[],
  env?: Record<string, string>,
): Promise<RpcResp[]> {
  const proc = spawn({
    cmd: ["bun", "run", SERVER_PATH],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const responses: RpcResp[] = [];

  async function waitFor(id: number): Promise<RpcResp> {
    while (true) {
      const hit = responses.find((r) => r.id === id);
      if (hit) return hit;
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

function callRead(id: number, path: string, bypassSummary?: boolean): RpcReq {
  const args: Record<string, unknown> = { path };
  if (bypassSummary !== undefined) args.bypassSummary = bypassSummary;
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__read", arguments: args },
  };
}

function textFor(responses: RpcResp[], id: number): string {
  const r = responses.find((x) => x.id === id);
  if (!r) throw new Error(`no response for id=${id}`);
  return r.result.content[0].text;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ashlr-cache-test-"));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("ashlr__read · per-process content cache", () => {
  test("same file read twice → second read returns (cached) prefix", async () => {
    const path = join(tmp, "file.txt");
    writeFileSync(path, "hello cache world");

    const responses = await rpcSequenced([
      INIT,
      callRead(2, path),
      callRead(3, path),
    ]);

    const first = textFor(responses, 2);
    const second = textFor(responses, 3);

    // First read returns raw content (small file, no snipCompact trigger).
    expect(first).toBe("hello cache world");
    // Second read hits the cache.
    expect(second.startsWith("(cached)\n")).toBe(true);
    // …and the cached payload is still the same content.
    expect(second).toBe("(cached)\nhello cache world");
  });

  test("file modified between reads → cache invalidates, re-reads", async () => {
    const path = join(tmp, "mut.txt");
    writeFileSync(path, "version-1");
    // Force mtime to a known past value so we can bump it deterministically.
    const past = new Date(Date.now() - 10_000);
    utimesSync(path, past, past);

    // Send first read, then mutate, then second read — all in one server session.
    // We can't interleave fs writes mid-rpcSequenced, so instead we do 3 calls
    // across 2 sessions: round 1 reads (populates cache), we mutate, round 2
    // reads in a fresh session (this is the unhappy-path for testing in-process
    // caches, but we *also* want to exercise invalidation inside one session —
    // so we use two sub-tests).

    // Sub-test A: in-process invalidation.
    // We manually call sequenced rpc with a callback-driven spawn so we can
    // mutate mid-stream.
    const proc = spawn({
      cmd: ["bun", "run", SERVER_PATH],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const responses: RpcResp[] = [];

    async function waitFor(id: number): Promise<RpcResp> {
      while (true) {
        const hit = responses.find((r) => r.id === id);
        if (hit) return hit;
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

    try {
      proc.stdin.write(JSON.stringify(INIT) + "\n");
      await waitFor(1);

      // First read — populates cache.
      proc.stdin.write(JSON.stringify(callRead(2, path)) + "\n");
      await waitFor(2);

      // Mutate content AND mtime.
      writeFileSync(path, "version-2-different");
      const now = new Date();
      utimesSync(path, now, now);

      // Second read — mtime changed → cache miss → returns new content.
      proc.stdin.write(JSON.stringify(callRead(3, path)) + "\n");
      await waitFor(3);

      const r2 = textFor(responses, 2);
      const r3 = textFor(responses, 3);
      expect(r2).toBe("version-1");
      // No cache prefix, re-read picks up the new content.
      expect(r3.startsWith("(cached)\n")).toBe(false);
      expect(r3).toBe("version-2-different");
    } finally {
      await proc.stdin.end();
      await proc.exited;
    }
  });

  test("bypassSummary=true does not populate cache", async () => {
    const path = join(tmp, "bypass.txt");
    writeFileSync(path, "bypass-me");

    const responses = await rpcSequenced([
      INIT,
      // First call with bypass=true — should NOT write to cache.
      callRead(2, path, true),
      // Second call without bypass — should MISS (because cache was never populated).
      callRead(3, path),
      // Third call without bypass — should HIT (because call #2 populated it).
      callRead(4, path),
    ]);

    const r2 = textFor(responses, 2);
    const r3 = textFor(responses, 3);
    const r4 = textFor(responses, 4);

    // Neither #2 (bypass) nor #3 (cold read) should be tagged cached.
    expect(r2.startsWith("(cached)\n")).toBe(false);
    expect(r3.startsWith("(cached)\n")).toBe(false);
    // #4 should now be cached by #3's write.
    expect(r4.startsWith("(cached)\n")).toBe(true);
  });

  test("bypassSummary=true skips the cache even when there's a prior cached entry", async () => {
    const path = join(tmp, "bp2.txt");
    writeFileSync(path, "stable");

    const responses = await rpcSequenced([
      INIT,
      // Populate cache.
      callRead(2, path),
      // Re-read without bypass — hits cache.
      callRead(3, path),
      // Re-read with bypass — must ignore cache, return raw (no "(cached)" tag).
      callRead(4, path, true),
    ]);

    expect(textFor(responses, 3).startsWith("(cached)\n")).toBe(true);
    expect(textFor(responses, 4).startsWith("(cached)\n")).toBe(false);
  });

  test("missing file returns an error and does not poison future reads", async () => {
    const ghost = join(tmp, "does-not-exist.txt");
    const real = join(tmp, "exists.txt");
    writeFileSync(real, "i am real");

    const responses = await rpcSequenced([
      INIT,
      callRead(2, ghost),
      callRead(3, real),
      callRead(4, real),
    ]);

    // Ghost read comes back as an error payload — the server catches it and
    // returns { isError: true, content: [...] } rather than crashing.
    const ghostResp = responses.find((r) => r.id === 2)!;
    expect(ghostResp.result.isError).toBe(true);

    // Real file reads still work — cache isn't poisoned by the earlier failure.
    const r3 = textFor(responses, 3);
    const r4 = textFor(responses, 4);
    expect(r3).toBe("i am real");
    expect(r4).toBe("(cached)\ni am real");
  });
});
