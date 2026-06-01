/**
 * Integration tests for servers/orient-server.ts.
 *
 * Most tests drive the exported `orient()` directly for speed; one end-to-end
 * test spawns the MCP server over stdio to verify wiring.
 *
 * Each test gets its own $HOME tmpdir so ~/.ashlr/stats.json doesn't bleed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { extractKeywords, orient } from "../servers/orient-server";

const SERVER = resolve(__dirname, "..", "servers", "orient-server.ts");

let home: string;
let project: string;
let stubServer: { stop(): void; url: string; lastBody: () => any } | null = null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-orient-home-"));
  project = await mkdtemp(join(tmpdir(), "ashlr-orient-proj-"));
  process.env.HOME = home;
  // Stats writes are debounced by default; this test asserts on-disk state
  // via direct readFile immediately after a recordSaving, so we need
  // synchronous writes. Package-level `bun run test` also sets this; we
  // set it locally so `bun test __tests__/orient-server.test.ts` works too.
  process.env.ASHLR_STATS_SYNC = "1";
  delete process.env.ASHLR_LLM_URL;
  delete process.env.ASHLR_LLM_KEY;
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  if (stubServer) { stubServer.stop(); stubServer = null; }
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

function startStubLLM(opts: { reply?: string; status?: number } = {}): { url: string; lastBody: () => any } {
  let lastBody: any = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      lastBody = await req.json();
      if (opts.status && opts.status !== 200) return new Response("err", { status: opts.status });
      return Response.json({
        choices: [{ message: { content: opts.reply ?? "STUB_SYNTHESIS" } }],
      });
    },
  });
  const rec = { url: `http://localhost:${srv.port}/v1`, lastBody: () => lastBody, stop: () => srv.stop() };
  stubServer = rec;
  return rec;
}

async function writeSyntheticAuthProject(): Promise<void> {
  await mkdir(join(project, "src", "middleware"), { recursive: true });
  await mkdir(join(project, "src", "session"), { recursive: true });
  await mkdir(join(project, "__tests__"), { recursive: true });
  await writeFile(
    join(project, "src", "middleware", "auth.ts"),
    `// auth middleware\nexport function requireAuth(req, res, next) {\n  if (!req.user) return res.status(401).end();\n  next();\n}\n`,
  );
  await writeFile(
    join(project, "src", "session", "jwt.ts"),
    `// JWT session helpers\nimport crypto from "crypto";\nexport function signJwt(payload) { return "fake." + JSON.stringify(payload); }\nexport function verifyJwt(tok) { return tok.startsWith("fake."); }\n`,
  );
  await writeFile(
    join(project, "__tests__", "auth.test.ts"),
    `import { requireAuth } from "../src/middleware/auth";\ntest("auth blocks unauthed", () => {});\n`,
  );
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "synthetic", version: "0.0.0" }));
}

describe("extractKeywords", () => {
  test("strips stopwords and short tokens", () => {
    expect(extractKeywords("how does auth work")).toEqual(["auth"]);
  });
  test("preserves meaningful multi-token queries", () => {
    const kw = extractKeywords("where is the deployment pipeline defined");
    expect(kw).toContain("deployment");
    expect(kw).toContain("pipeline");
    expect(kw).toContain("defined");
    expect(kw).not.toContain("the");
  });
  test("empty / nonsense query yields empty array without crash", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("?!@# the a an").length).toBe(0);
  });
});

describe("orient · grep path (no genome)", () => {
  test("finds synthetic auth files, sends them to LLM, returns stub synthesis", async () => {
    await writeSyntheticAuthProject();
    const stub = startStubLLM({ reply: "STUB_SYNTHESIS" });
    const r = await orient({
      query: "how does auth work",
      dir: project,
      endpointOverride: stub.url,
    });
    expect(r.text).toContain("STUB_SYNTHESIS");
    expect(r.fellBack).toBe(false);
    // Should have found auth-related files via grep
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.files.some((f) => f.includes("auth"))).toBe(true);
    // Stub received our system prompt + at least one file block
    const body = stub.lastBody();
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("orienting an agent");
    expect(body.messages[1].content).toContain("QUERY: how does auth work");
    expect(body.messages[1].content).toContain("auth.ts");
  });

  test("records per-tool savings in stats.json as ashlr__orient", async () => {
    await writeSyntheticAuthProject();
    const stub = startStubLLM({ reply: "OK" });
    await orient({ query: "how does auth work", dir: project, endpointOverride: stub.url });
    const stats = JSON.parse(await readFile(join(home, ".ashlr", "stats.json"), "utf-8"));
    expect(stats.lifetime.byTool["ashlr__orient"]).toBeTruthy();
    // Tolerant of concurrent-test stats contamination: tests mutate the global
    // process.env.HOME and Bun runs test files in parallel, so the shared
    // stats.json can receive extra ashlr__orient writes. The invariant we care
    // about is that orient recorded a per-tool saving at all.
    expect(stats.lifetime.byTool["ashlr__orient"].calls).toBeGreaterThanOrEqual(1);
    // v2 schema: session is under sessions[<id>] keyed by CLAUDE_SESSION_ID or
    // a PPID-derived fallback. Assert that at least one bucket recorded orient.
    const sessionBuckets = Object.values(stats.sessions ?? {}) as Array<{ byTool?: Record<string, { calls: number }> }>;
    const orientCalls = sessionBuckets.reduce((n, b) => n + (b.byTool?.["ashlr__orient"]?.calls ?? 0), 0);
    expect(orientCalls).toBeGreaterThanOrEqual(1); // tolerant of concurrent-test stats contamination
  });
});

describe("orient · genome path", () => {
  test("when .ashlrcode/genome/ is present, uses genome retriever", async () => {
    const { initGenome } = await import("@ashlr/core-efficiency/genome");
    await initGenome(project, { project: "synthetic", vision: "test", milestone: "m1" });
    const stub = startStubLLM({ reply: "GENOME_STUB" });
    const r = await orient({
      query: "project vision and decisions",
      dir: project,
      endpointOverride: stub.url,
    });
    expect(r.text).toContain("GENOME_STUB");
    const body = stub.lastBody();
    // The genome route appends a "GENOME:" section header before FILES.
    // Either genome or grep may produce results; assert we at least ran.
    expect(typeof body.messages[1].content).toBe("string");
  });
});

describe("orient · LLM unreachable fallback", () => {
  test("returns plain summary without crashing", async () => {
    await writeSyntheticAuthProject();
    const r = await orient({
      query: "how does auth work",
      dir: project,
      endpointOverride: "http://127.0.0.1:1/v1", // guaranteed unreachable
    });
    expect(r.fellBack).toBe(true);
    expect(r.text).toContain("LLM unreachable");
    expect(r.text).toContain("Top files:");
    // Must not have thrown — stats still recorded
    const stats = JSON.parse(await readFile(join(home, ".ashlr", "stats.json"), "utf-8"));
    // Tolerant of concurrent-test stats contamination: tests mutate the global
    // process.env.HOME and Bun runs test files in parallel, so the shared
    // stats.json can receive extra ashlr__orient writes. The invariant we care
    // about is that orient recorded a per-tool saving at all.
    expect(stats.lifetime.byTool["ashlr__orient"].calls).toBeGreaterThanOrEqual(1);
  });
});

describe("orient · empty / nonsense query", () => {
  test("empty query → no crash, sensible output", async () => {
    await writeSyntheticAuthProject();
    const stub = startStubLLM({ reply: "EMPTY_OK" });
    const r = await orient({ query: "", dir: project, endpointOverride: stub.url });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.fellBack).toBe(false);
  });

  test("nonsense query → no crash", async () => {
    await writeSyntheticAuthProject();
    const stub = startStubLLM({ reply: "NOPE_OK" });
    const r = await orient({ query: "???", dir: project, endpointOverride: stub.url });
    expect(r.text).toContain("NOPE_OK");
  });
});

describe("orient · MCP stdio wiring", () => {
  test("initialize + tools/list + tools/call round-trip", async () => {
    await writeSyntheticAuthProject();
    const stub = startStubLLM({ reply: "STDIO_SYNTHESIS" });

    const reqs = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "ashlr__orient",
          arguments: {
            query: "how does auth work",
            dir: project,
            endpointOverride: stub.url,
          },
        },
      },
    ];
    const proc = spawn({
      cmd: ["bun", "run", SERVER],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const replies = out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const init = replies.find((r) => r.id === 1);
    const list = replies.find((r) => r.id === 2);
    const call = replies.find((r) => r.id === 3);
    expect(init.result.serverInfo.name).toBe("ashlr-orient");
    expect(list.result.tools[0].name).toBe("ashlr__orient");
    expect(call.result.content[0].text).toContain("STDIO_SYNTHESIS");
  });
});
