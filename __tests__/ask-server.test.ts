/**
 * Tests for servers/ask-server.ts
 *
 * Covers:
 *  - routeQuestion: full routing matrix (one case per rule)
 *  - askHandler: underlying handler is called; trace is first line
 *  - Event log receives routing decision
 *  - MCP stdio spawn: tools/list returns ashlr__ask
 *
 * Handler mocking strategy: we override the imported modules with
 * module-level mock functions injected via dependency injection helpers,
 * but since bun:test doesn't support jest.mock for ESM imports we test
 * the routing logic (routeQuestion) directly and integration-test the
 * full pipeline by verifying the trace prefix on askHandler output.
 * The MCP wiring test spawns the real server process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join, resolve } from "path";

import { routeQuestion } from "../servers/ask-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER = resolve(__dirname, "..", "servers", "ask-server.ts");

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
    cmd: ["bun", "run", SERVER],
    cwd: resolve(__dirname, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home ?? process.env.HOME ?? homedir(), ASHLR_STATS_SYNC: "1" },
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let home: string;
let project: string;

// Snapshot+restore env so this file's `ASHLR_SESSION_LOG = "0"` doesn't
// leak to later test files (Windows test-ordering hit this — proactive-nudges
// throttle tests saw the leaked kill switch and false-positive-failed).
let _origSessionLog: string | undefined;
let _origStatsSync: string | undefined;
let _origHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-ask-home-"));
  project = await mkdtemp(join(tmpdir(), "ashlr-ask-proj-"));
  _origSessionLog = process.env.ASHLR_SESSION_LOG;
  _origStatsSync = process.env.ASHLR_STATS_SYNC;
  _origHome = process.env.HOME;
  process.env.HOME = home;
  process.env.ASHLR_STATS_SYNC = "1";
  process.env.ASHLR_SESSION_LOG = "0"; // silence event writes in unit tests
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(project, { recursive: true, force: true }).catch(() => {});
  if (_origSessionLog === undefined) delete process.env.ASHLR_SESSION_LOG;
  else process.env.ASHLR_SESSION_LOG = _origSessionLog;
  if (_origStatsSync === undefined) delete process.env.ASHLR_STATS_SYNC;
  else process.env.ASHLR_STATS_SYNC = _origStatsSync;
  if (_origHome === undefined) delete process.env.HOME;
  else process.env.HOME = _origHome;
});

// ---------------------------------------------------------------------------
// routeQuestion: routing matrix
// ---------------------------------------------------------------------------

describe("routeQuestion · routing matrix", () => {
  test("glob pattern → ashlr__glob", () => {
    const d = routeQuestion("find all **/*.ts files");
    expect(d.tool).toBe("ashlr__glob");
    expect(d.extracted).toContain("**/*.ts");
  });

  test("glob pattern bare → ashlr__glob", () => {
    const d = routeQuestion("**/*.test.ts");
    expect(d.tool).toBe("ashlr__glob");
  });

  test("src/*.py pattern → ashlr__glob", () => {
    const d = routeQuestion("src/*.py");
    expect(d.tool).toBe("ashlr__glob");
  });

  test("read verb + path → ashlr__read", () => {
    const d = routeQuestion("read servers/orient-server.ts");
    expect(d.tool).toBe("ashlr__read");
    expect(d.extracted).toContain("orient-server.ts");
  });

  test("show me + path → ashlr__read", () => {
    const d = routeQuestion("show me src/index.ts");
    expect(d.tool).toBe("ashlr__read");
  });

  test("what's in + path → ashlr__read", () => {
    const d = routeQuestion("what's in package.json");
    expect(d.tool).toBe("ashlr__read");
  });

  test("contents of + path → ashlr__read", () => {
    const d = routeQuestion("contents of .env");
    expect(d.tool).toBe("ashlr__read");
  });

  test("grep verb → ashlr__grep", () => {
    const d = routeQuestion("grep logEvent calls");
    expect(d.tool).toBe("ashlr__grep");
  });

  test("find verb → ashlr__grep", () => {
    const d = routeQuestion("find all usages of recordSaving");
    expect(d.tool).toBe("ashlr__grep");
  });

  test("search verb → ashlr__grep", () => {
    const d = routeQuestion("search for extractKeywords");
    expect(d.tool).toBe("ashlr__grep");
  });

  test("where is verb → ashlr__grep", () => {
    const d = routeQuestion("where is logEvent defined");
    expect(d.tool).toBe("ashlr__grep");
  });

  test("which file verb → ashlr__grep", () => {
    const d = routeQuestion("which file imports orient");
    expect(d.tool).toBe("ashlr__grep");
  });

  test("how does X work → ashlr__orient", () => {
    const d = routeQuestion("how does auth work here");
    expect(d.tool).toBe("ashlr__orient");
    expect(d.reason).toContain("structural");
  });

  test("explain → ashlr__orient", () => {
    const d = routeQuestion("explain the genome pipeline");
    expect(d.tool).toBe("ashlr__orient");
  });

  test("walk me through → ashlr__orient", () => {
    const d = routeQuestion("walk me through the deploy flow");
    expect(d.tool).toBe("ashlr__orient");
  });

  test("why does → ashlr__orient", () => {
    const d = routeQuestion("why does snipCompact truncate at 2KB");
    expect(d.tool).toBe("ashlr__orient");
  });

  test("how do we → ashlr__orient", () => {
    const d = routeQuestion("how do we handle errors in the MCP server");
    expect(d.tool).toBe("ashlr__orient");
  });

  test("list verb (no path) → ashlr__tree", () => {
    const d = routeQuestion("list the project structure");
    expect(d.tool).toBe("ashlr__tree");
  });

  test("tree verb → ashlr__tree", () => {
    const d = routeQuestion("show me the tree");
    // "show me" without a path token → tree verb wins
    expect(d.tool).toBe("ashlr__tree");
  });

  test("directory structure → ashlr__tree", () => {
    const d = routeQuestion("what is the directory layout");
    expect(d.tool).toBe("ashlr__tree");
  });

  test("ambiguous short question falls through to orient", () => {
    const d = routeQuestion("token savings");
    expect(d.tool).toBe("ashlr__orient");
    expect(d.reason).toContain("fallback");
  });

  test("empty string falls back to orient", () => {
    const d = routeQuestion("");
    expect(d.tool).toBe("ashlr__orient");
  });
});

// ---------------------------------------------------------------------------
// routeQuestion: trace line is always present
// ---------------------------------------------------------------------------

describe("routeQuestion · trace contract", () => {
  test("every decision has a non-empty reason", () => {
    const cases = [
      "**/*.ts",
      "read package.json",
      "grep logEvent",
      "how does auth work",
      "list files",
      "something random",
    ];
    for (const q of cases) {
      const d = routeQuestion(q);
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// askHandler integration: trace is first line of output
// ---------------------------------------------------------------------------

describe("askHandler · integration (real handlers, temp project)", () => {
  test("trace line is the first line of output for orient fallback", async () => {
    // Write a minimal project file so orient/grep have something to scan.
    await writeFile(join(project, "README.md"), "# Test project\n");

    // Import lazily to avoid module-level side effects at collect time.
    const { askHandler } = await import("../servers/ask-server");
    const output = await askHandler({ question: "token savings", cwd: project });
    const firstLine = output.split("\n")[0]!;
    expect(firstLine).toMatch(/^\[ashlr__ask\] routed to ashlr__orient/);
  });

  test("trace line for grep question starts with [ashlr__ask] routed to ashlr__grep", async () => {
    await writeFile(join(project, "index.ts"), 'export const hello = "world";\n');

    const { askHandler } = await import("../servers/ask-server");
    const output = await askHandler({ question: "grep hello", cwd: project });
    const firstLine = output.split("\n")[0]!;
    expect(firstLine).toMatch(/^\[ashlr__ask\] routed to ashlr__grep/);
  });

  test("trace line for tree question starts with [ashlr__ask] routed to ashlr__tree", async () => {
    const { askHandler } = await import("../servers/ask-server");
    const output = await askHandler({ question: "list the directory structure", cwd: project });
    const firstLine = output.split("\n")[0]!;
    expect(firstLine).toMatch(/^\[ashlr__ask\] routed to ashlr__tree/);
  });

  test("trace line for glob question starts with [ashlr__ask] routed to ashlr__glob", async () => {
    await writeFile(join(project, "app.ts"), "export {};\n");

    const { askHandler } = await import("../servers/ask-server");
    const output = await askHandler({ question: "**/*.ts", cwd: project });
    const firstLine = output.split("\n")[0]!;
    expect(firstLine).toMatch(/^\[ashlr__ask\] routed to ashlr__glob/);
  });
});

// ---------------------------------------------------------------------------
// Event log receives routing decision
// ---------------------------------------------------------------------------

describe("askHandler · event log", () => {
  test("routing decision is logged when ASHLR_SESSION_LOG is enabled", async () => {
    // Enable event logging for this test.
    process.env.ASHLR_SESSION_LOG = "1";
    const logFile = join(home, ".ashlr", "session-log.jsonl");

    await writeFile(join(project, "hello.ts"), "export const x = 1;\n");

    const { askHandler } = await import("../servers/ask-server");
    await askHandler({ question: "grep hello", cwd: project });

    // Give async appendFile a moment to flush.
    await Bun.sleep(50);

    const { readFile } = await import("fs/promises");
    const raw = await readFile(logFile, "utf-8").catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const askLines = lines.filter((e: any) => e.tool === "ashlr__ask");
    expect(askLines.length).toBeGreaterThan(0);
    const entry = askLines[askLines.length - 1];
    expect(entry.event).toBe("tool_call");
    expect(entry.reason).toMatch(/routed-to=ashlr__grep/);

    process.env.ASHLR_SESSION_LOG = "0";
  });
});

// ---------------------------------------------------------------------------
// MCP wiring: stdio spawn
// ---------------------------------------------------------------------------

describe("ashlr-ask · MCP wiring", () => {
  test("initialize + tools/list returns ashlr__ask", async () => {
    const [init, list] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ], home);

    expect(init.result).toMatchObject({
      serverInfo: { name: "ashlr-ask" },
    });

    const tools: Array<{ name: string }> = list.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("ashlr__ask");
  });

  test("tools/call ashlr__ask returns trace as first line", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "ashlr-ask-mcp-"));
    await mkdir(join(tmpHome, ".ashlr"), { recursive: true });
    // Write a small project dir to give the handlers something to scan.
    const tmpProj = await mkdtemp(join(tmpdir(), "ashlr-ask-mcp-proj-"));
    await writeFile(join(tmpProj, "index.ts"), "export const x = 1;\n");

    try {
      const [, , callResp] = await rpc(
        [
          INIT,
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "ashlr__ask",
              arguments: { question: "list the directory", cwd: tmpProj },
            },
          },
        ],
        tmpHome,
      );

      const text: string = callResp.result.content[0].text;
      expect(text.split("\n")[0]).toMatch(/^\[ashlr__ask\] routed to /);
    } finally {
      await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
      await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
    }
  });
});
