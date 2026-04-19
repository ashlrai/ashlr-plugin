/**
 * End-to-end integration tests for the ashlr-tree MCP server.
 *
 * Spawns the real server, speaks JSON-RPC over stdio, asserts on responses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
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
  cwd?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  // Resolve the server path absolutely so the spawn's cwd can be anywhere
  // (e.g., a tmp dir). The v1.11.2 clamp reads process.cwd() in the spawned
  // server, so the test must control cwd — that only works with an absolute
  // cmd path.
  const serverPath = join(import.meta.dir, "..", "servers", "tree-server.ts");
  const proc = spawn({
    cmd: ["bun", "run", serverPath],
    cwd,
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

function callTree(id: number, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__tree", arguments: args },
  };
}

describe("ashlr-tree · bootstrap", () => {
  test("initialize + tools/list", async () => {
    const [init, list] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    expect(init.result).toMatchObject({
      serverInfo: { name: "ashlr-tree", version: "0.1.0" },
    });
    const tools = list.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["ashlr__tree"]);
    expect(tools[0].description.length).toBeGreaterThan(30);
    expect(tools[0].inputSchema.type).toBe("object");
  });
});

describe("ashlr-tree · basic scans", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-tree-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("empty directory → empty message, no crash", async () => {
    const [, r] = await rpc([INIT, callTree(2, { path: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toContain("[empty]");
  });

  test("path doesn't exist → clean error", async () => {
    const [, r] = await rpc([INIT, callTree(2, { path: join(tmp, "nope") })], tmp);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("does not exist");
  });

  test("synthetic tree matches expected shape", async () => {
    await mkdir(join(tmp, "src/agent"), { recursive: true });
    await writeFile(join(tmp, "src/agent/a.ts"), "a\n".repeat(10));
    await writeFile(join(tmp, "src/agent/b.ts"), "b\n".repeat(20));
    await writeFile(join(tmp, "src/index.ts"), "x\n");
    await writeFile(join(tmp, "README.md"), "# hi\n");

    const [, r] = await rpc([INIT, callTree(2, { path: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    expect(text).toContain("src/");
    expect(text).toContain("agent/");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).toContain("index.ts");
    expect(text).toContain("README.md");
    expect(text).toContain("dirs");
    expect(text).toContain("files");
    // Unicode box-drawing used
    expect(/[├└│─]/.test(text)).toBe(true);
  });
});

describe("ashlr-tree · truncation behavior", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-tree-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("large dir (300+ files) → per-dir truncation visible", async () => {
    await mkdir(join(tmp, "many"), { recursive: true });
    // Create 300 files — keep small.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 300; i++) {
      writes.push(writeFile(join(tmp, "many", `f${i.toString().padStart(4, "0")}.txt`), "x"));
    }
    await Promise.all(writes);

    const [, r] = await rpc([INIT, callTree(2, { path: tmp, maxEntries: 30 })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    expect(text).toMatch(/\[\.\.\. \d+ more \.\.\.\]/);
  });

  test("maxEntries cap reached → truncated reported", async () => {
    await mkdir(join(tmp, "many"), { recursive: true });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      writes.push(writeFile(join(tmp, "many", `f${i}.txt`), "x"));
    }
    await Promise.all(writes);

    const [, r] = await rpc([INIT, callTree(2, { path: tmp, maxEntries: 5 })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    // Either hit the budget or elided the dir; at minimum an elision marker appears.
    expect(/\[\.\.\. \d+ more \.\.\.\]|truncated: true/.test(text)).toBe(true);
  });
});

describe("ashlr-tree · git repo gitignore", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-tree-git-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("honors .gitignore inside a git repo", async () => {
    // Init a git repo
    spawnSync({ cmd: ["git", "init", "-q"], cwd: tmp });
    spawnSync({ cmd: ["git", "config", "user.email", "t@t"], cwd: tmp });
    spawnSync({ cmd: ["git", "config", "user.name", "t"], cwd: tmp });
    await writeFile(join(tmp, ".gitignore"), "secret.txt\n");
    await writeFile(join(tmp, "visible.txt"), "v\n");
    await writeFile(join(tmp, "secret.txt"), "shh\n");

    const [, r] = await rpc([INIT, callTree(2, { path: tmp })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    expect(text).toContain("visible.txt");
    expect(text).not.toContain("secret.txt");
  });
});

describe("ashlr-tree · loc option", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-tree-loc-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("loc:true shows LOC for text files, skips binaries", async () => {
    await writeFile(join(tmp, "code.ts"), "line1\nline2\nline3\n");
    // Binary: contains NUL bytes
    await writeFile(join(tmp, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 4, 0]));

    const [, r] = await rpc([INIT, callTree(2, { path: tmp, loc: true })], tmp);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text;
    expect(text).toMatch(/code\.ts.*3 LOC/);
    // blob.bin should NOT have LOC annotation
    const blobLine = text.split("\n").find((l: string) => l.includes("blob.bin"));
    expect(blobLine).toBeDefined();
    expect(blobLine).not.toContain("LOC");
  });
});
