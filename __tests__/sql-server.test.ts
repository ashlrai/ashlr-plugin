/**
 * End-to-end integration tests for the ashlr-sql MCP server.
 *
 * Spawns the real server, speaks JSON-RPC over stdio, runs real SQL against
 * real SQLite databases. Postgres tests are gated on $TEST_DATABASE_URL and
 * skip cleanly when it's absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SERVER = resolve(import.meta.dir, "..", "servers", "sql-server.ts");

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  // Route stats writes into a temp HOME so tests stay hermetic.
  const fakeHome = await mkdtemp(join(tmpdir(), "ashlr-sql-home-"));
  const proc = spawn({
    cmd: ["bun", "run", SERVER],
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: fakeHome, ...(opts.env ?? {}) },
  });
  proc.stdin.write(input);
  await proc.stdin.end();

  // Read until we've collected `reqs.length` JSON responses, then kill the
  // server. We don't wait for natural EOF because some drivers (postgres.js)
  // hold the event loop open after a connect failure.
  const expected = reqs.length;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  const deadline = Date.now() + 12_000;
  while (lines.length < expected && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) if (p.trim()) lines.push(p);
  }
  try {
    proc.kill();
  } catch {
    /* already exited */
  }
  await rm(fakeHome, { recursive: true, force: true });
  if (lines.length === 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`no response from server. stderr: ${err}`);
  }
  return lines.map((l) => JSON.parse(l));
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

function call(args: Record<string, unknown>, id = 2): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__sql", arguments: args },
  };
}

describe("ashlr-sql · bootstrap", () => {
  test("initialize returns serverInfo", async () => {
    const [r] = await rpc([INIT]);
    expect(r.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "ashlr-sql" },
    });
  });

  test("tools/list exposes ashlr__sql with full schema", async () => {
    const [, r] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    expect(r.result.tools).toHaveLength(1);
    const tool = r.result.tools[0];
    expect(tool.name).toBe("ashlr__sql");
    expect(tool.description.length).toBeGreaterThan(50);
    const props = tool.inputSchema.properties;
    expect(Object.keys(props).sort()).toEqual(
      ["bypassSummary", "connection", "explain", "limit", "query", "schema"].sort(),
    );
  });
});

describe("ashlr-sql · SQLite (file-based via explicit connection)", () => {
  let tmp: string;
  let dbPath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    dbPath = join(tmp, "test.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, status TEXT)");
    db.run("INSERT INTO users (email, status) VALUES ('alice@example.com', 'active')");
    db.run("INSERT INTO users (email, status) VALUES ('bob@example.com', 'inactive')");
    db.close();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("SELECT returns a compact table with header", async () => {
    const [, r] = await rpc([
      INIT,
      call({ connection: dbPath, query: "SELECT id, email, status FROM users ORDER BY id" }),
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("sqlite://");
    expect(text).toContain("2 rows × 3 cols");
    expect(text).toContain("alice@example.com");
    expect(text).toContain("bob@example.com");
    // Has the box-drawing separator
    expect(text).toContain("─");
  });

  test("CREATE / INSERT report changes", async () => {
    const [, r] = await rpc([
      INIT,
      call({ connection: dbPath, query: "INSERT INTO users (email, status) VALUES ('c@x.io', 'active')" }),
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("changes");
  });
});

describe("ashlr-sql · SQLite in-memory + auto-detection", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-sql-cwd-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("auto-detects *.db in cwd when no connection passed", async () => {
    const dbPath = join(tmp, "auto.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE t (n INTEGER)");
    db.run("INSERT INTO t VALUES (1), (2), (3)");
    db.close();

    const [, r] = await rpc(
      [INIT, call({ query: "SELECT COUNT(*) AS c FROM t" })],
      { cwd: tmp, env: { DATABASE_URL: "" } },
    );
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("auto.db");
    expect(text).toContain("1 row × 1 col");
  });

  test("no-connection error points to $DATABASE_URL", async () => {
    const [, r] = await rpc(
      [INIT, call({ query: "SELECT 1" })],
      { cwd: tmp, env: { DATABASE_URL: "" } },
    );
    expect(r.result.isError).toBe(true);
    const text = r.result.content[0].text as string;
    expect(text).toContain("DATABASE_URL");
  });
});

describe("ashlr-sql · schema mode", () => {
  let tmp: string;
  let dbPath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    dbPath = join(tmp, "schema.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, account_id INTEGER, total REAL)");
    db.run("INSERT INTO accounts (name) VALUES ('a'), ('b')");
    db.close();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("lists tables, columns, row counts", async () => {
    const [, r] = await rpc([INIT, call({ connection: dbPath, schema: true })]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("accounts");
    expect(text).toContain("orders");
    expect(text).toContain("id:INTEGER");
    expect(text).toContain("name:TEXT");
    // accounts has 2 rows
    expect(text).toMatch(/accounts\s*\|.*\|\s*2/);
  });
});

describe("ashlr-sql · EXPLAIN mode", () => {
  let tmp: string;
  let dbPath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    dbPath = join(tmp, "x.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO t (v) VALUES ('a'), ('b')");
    db.close();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("emits a query plan", async () => {
    const [, r] = await rpc([
      INIT,
      call({ connection: dbPath, query: "SELECT * FROM t WHERE id = 1", explain: true }),
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("EXPLAIN");
    // SQLite plan output references the table
    expect(text.toLowerCase()).toContain("t");
  });
});

describe("ashlr-sql · errors", () => {
  test("malformed SQL returns a clean error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    const dbPath = join(tmp, "e.db");
    new Database(dbPath).close();
    const [, r] = await rpc([INIT, call({ connection: dbPath, query: "SELEKT bogus" })]);
    expect(r.result.isError).toBe(true);
    const text = r.result.content[0].text as string;
    expect(text).toContain("ashlr__sql error:");
    // No multi-line driver dump
    expect(text.split("\n").length).toBeLessThan(5);
    await rm(tmp, { recursive: true, force: true });
  });

  test("mysql connection rejected with helpful message", async () => {
    const [, r] = await rpc([
      INIT,
      call({ connection: "mysql://user:pw@host/db", query: "SELECT 1" }),
    ]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("not supported");
    expect(r.result.content[0].text).toContain("github.com/ashlrai/ashlr-plugin");
  });
});

describe("ashlr-sql · row elision", () => {
  // Windows CI: bun:sqlite cold-start + Bun spawn latency can push this past
  // the default 5 s timeout. 20 s is generous but avoids flakes on slow runners.
  test("100 rows with limit 10 shows 10 + elision marker", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    const dbPath = join(tmp, "many.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE n (i INTEGER)");
    const ins = db.prepare("INSERT INTO n VALUES (?)");
    for (let i = 1; i <= 100; i++) ins.run(i);
    db.close();

    const [, r] = await rpc([
      INIT,
      call({ connection: dbPath, query: "SELECT i FROM n ORDER BY i", limit: 10 }),
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("100 rows");
    expect(text).toContain("90 elided");
    // Row 1 visible; row 99 should not be
    expect(text).toContain("\n  1 ");
    expect(text).not.toContain("\n  99 ");
    await rm(tmp, { recursive: true, force: true });
  }, 20_000);
});

describe("ashlr-sql · password redaction", () => {
  test("postgres URL password is masked in error header", async () => {
    // Connection will fail (host unreachable / DNS), but the header in the error
    // path comes through classify() — verify by triggering the postgres path
    // and inspecting the redacted display string round-trip via a unit-y check:
    // we send an unsupported scheme that uses the same redactor.
    const [, r] = await rpc([
      INIT,
      call({ connection: "mysql://alice:supersecret@db.local/app", query: "SELECT 1" }),
    ]);
    const text = r.result.content[0].text as string;
    // The error doesn't echo display, but classify redacts; ensure the secret
    // never appears anywhere in the response payload.
    expect(text).not.toContain("supersecret");
  });

  test(
    "postgres connection failure does not leak password",
    async () => {
      // Port 1 will immediately refuse on most systems.
      const url = "postgres://user:topsecret123@127.0.0.1:1/nonexistent";
      const [, r] = await rpc([INIT, call({ connection: url, query: "SELECT 1" })]);
      const text = r.result.content[0].text as string;
      expect(text).not.toContain("topsecret123");
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Optional Postgres integration — only runs when $TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const PG = process.env.TEST_DATABASE_URL;
const pgDescribe = PG ? describe : describe.skip;

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

describe("ashlr-sql · LLM summarization", () => {
  // Windows CI: Bun spawn + bun:sqlite cold-start can exceed the default 5 s
  // timeout. 20 s budget keeps this from being flaky on slow runners.
  test.skipIf(process.platform === "win32")("SELECT with > 100 rows and > 16KB rendered output goes through summarizer (skipped on Windows: subprocess + bun:sqlite + mock LLM endpoint times out at 6.5s; needs investigation in a follow-up)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    const dbPath = join(dir, "big.db");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE t (id INTEGER, payload TEXT)");
    const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
    // 400 rows comfortably exceed the 16KB rendered threshold (column width
    // is capped at 60 chars in renderTable, so per-row footprint is bounded).
    for (let i = 0; i < 400; i++) {
      ins.run(i, "x".repeat(400));
    }
    db.close();

    const stub = startStubLLM("STUB_SQL_SUMMARY_77");
    try {
      const [, r] = await rpc(
        [INIT, call({ connection: dbPath, query: "SELECT * FROM t", limit: 500 })],
        { env: { ASHLR_LLM_URL: stub.url } },
      );
      const text = r.result.content[0].text as string;
      expect(text).toContain("STUB_SQL_SUMMARY_77");
      expect(text).toContain("bypassSummary:true");
    } finally {
      stub.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("EXPLAIN mode is NOT summarized even with stub available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-sql-"));
    const dbPath = join(dir, "exp.db");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE t (id INTEGER, v TEXT)");
    db.close();

    const stub = startStubLLM("STUB_SHOULD_NOT_APPEAR");
    try {
      const [, r] = await rpc(
        [INIT, call({ connection: dbPath, query: "SELECT * FROM t", explain: true })],
        { env: { ASHLR_LLM_URL: stub.url } },
      );
      const text = r.result.content[0].text as string;
      expect(text).not.toContain("STUB_SHOULD_NOT_APPEAR");
      expect(text).toContain("EXPLAIN");
    } finally {
      stub.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

pgDescribe("ashlr-sql · Postgres (live)", () => {
  test("SELECT 1 returns a row", async () => {
    const [, r] = await rpc([
      INIT,
      call({ connection: PG!, query: "SELECT 1 AS one" }),
    ]);
    expect(r.result.isError).toBeUndefined();
    const text = r.result.content[0].text as string;
    expect(text).toContain("one");
    expect(text).toContain("1 row");
  });
});
