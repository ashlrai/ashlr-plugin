/**
 * cli-orchestrate-status.test.ts — Q1 '27 status CLI for orchestrate runs.
 *
 * Coverage matrix:
 *   - empty dir + non-existent dir → "No orchestration runs yet" + exit 0
 *   - list mode with N fixture runs → table contains every id + goal
 *   - detail mode for an existing id → tree + per-node info
 *   - detail mode for missing id → "No run found" + exit 1
 *   - --json flag (list + detail) → output is parseable JSON
 *   - --last <N> caps the row count
 *   - sort order: startedAt DESC
 *   - malformed result.json → skipped with stderr warning, never throws
 *   - path-traversal guard on graphId (e.g. `..`)
 *   - --last invalid arg falls back to default
 *
 * Tests redirect HOME to a tmp dir via deps.home so they never touch the
 * real ~/.ashlr/. Pattern mirrors __tests__/cli-orchestrate.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  isSafeGraphId,
  loadRecord,
  loadAllRecords,
  main,
  parseArgs,
  renderDetail,
  renderList,
  type PersistedRecord,
} from "../scripts/cli-orchestrate-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;

function makeFixture(overrides: {
  id: string;
  goal?: string;
  startedAt: string;
  ok?: boolean;
  tier?: string;
  tokens?: number;
  nodes?: Array<{
    id: string;
    agentKind?: string;
    ok?: boolean;
    durationMs?: number;
    tokens?: number;
    error?: string;
  }>;
}): PersistedRecord {
  const ok = overrides.ok ?? true;
  const nodes = overrides.nodes ?? [
    { id: "explore", agentKind: "refactorer", ok: true, durationMs: 200, tokens: 1000 },
    { id: "implement", agentKind: "refactorer", ok: true, durationMs: 400, tokens: 1500 },
  ];
  const totalTokens = overrides.tokens ?? nodes.reduce((s, n) => s + (n.tokens ?? 0), 0);
  return {
    graph: {
      id: overrides.id,
      goal: overrides.goal ?? `goal for ${overrides.id}`,
      scope: "/tmp/work",
      tier: overrides.tier ?? "pro",
      createdAt: overrides.startedAt,
      nodes: nodes.map((n) => ({
        id: n.id,
        agentKind: n.agentKind ?? "generic",
        goal: `goal for ${n.id}`,
        scope: ["./a"],
        deps: [],
      })),
    },
    result: {
      ok,
      graphId: overrides.id,
      startedAt: overrides.startedAt,
      finishedAt: overrides.startedAt,
      totalDurationMs: 600,
      totalTokens,
      totalTokensUsed: totalTokens,
      nodes: nodes.map((n) => ({
        id: n.id,
        nodeId: n.id,
        ok: n.ok ?? true,
        durationMs: n.durationMs ?? 100,
        tokens: n.tokens ?? 0,
        tokensUsed: n.tokens ?? 0,
        error: n.error,
      })),
      nodeResults: nodes.map((n) => ({
        id: n.id,
        nodeId: n.id,
        ok: n.ok ?? true,
        durationMs: n.durationMs ?? 100,
        tokens: n.tokens ?? 0,
        tokensUsed: n.tokens ?? 0,
        error: n.error,
      })),
    },
  };
}

function writeFixture(home: string, rec: PersistedRecord): void {
  const dir = join(home, ".ashlr", "orchestrations", rec.graph.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(rec, null, 2));
}

interface CapOut {
  out: string;
  err: string;
}

function captureFns() {
  const cap: CapOut = { out: "", err: "" };
  return {
    cap,
    stdout: (s: string) => {
      cap.out += s;
    },
    stderr: (s: string) => {
      cap.err += s;
    },
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-orch-status-"));
});

afterEach(() => {
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("defaults", () => {
    const args = parseArgs([]);
    expect(args).toEqual({ graphId: null, json: false, last: 10 });
  });

  test("graph-id positional", () => {
    expect(parseArgs(["g-abc"]).graphId).toBe("g-abc");
  });

  test("--json without id", () => {
    expect(parseArgs(["--json"])).toEqual({ graphId: null, json: true, last: 10 });
  });

  test("--json with id", () => {
    expect(parseArgs(["--json", "g-abc"])).toEqual({
      graphId: "g-abc",
      json: true,
      last: 10,
    });
  });

  test("--last <N>", () => {
    expect(parseArgs(["--last", "5"]).last).toBe(5);
  });

  test("--last with garbage falls back to default", () => {
    expect(parseArgs(["--last", "abc"]).last).toBe(10);
  });

  test("--last with zero or negative falls back to default", () => {
    expect(parseArgs(["--last", "0"]).last).toBe(10);
    expect(parseArgs(["--last", "-3"]).last).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// isSafeGraphId
// ---------------------------------------------------------------------------

describe("isSafeGraphId", () => {
  test("accepts alphanumeric + hyphen + underscore", () => {
    expect(isSafeGraphId("g-abc-123")).toBe(true);
    expect(isSafeGraphId("g_abc")).toBe(true);
    expect(isSafeGraphId("abc123")).toBe(true);
  });

  test("rejects path-traversal attempts", () => {
    expect(isSafeGraphId("..")).toBe(false);
    expect(isSafeGraphId("../../etc/passwd")).toBe(false);
    expect(isSafeGraphId("./foo")).toBe(false);
    expect(isSafeGraphId("/abs/path")).toBe(false);
    expect(isSafeGraphId("a/b")).toBe(false);
    expect(isSafeGraphId("a.b")).toBe(false);
    expect(isSafeGraphId("")).toBe(false);
  });

  test("rejects overly long ids", () => {
    expect(isSafeGraphId("a".repeat(129))).toBe(false);
    expect(isSafeGraphId("a".repeat(128))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// main — list mode
// ---------------------------------------------------------------------------

describe("main — list mode", () => {
  test("non-existent dir → 'No orchestration runs yet' + exit 0", async () => {
    const { cap, stdout, stderr } = captureFns();
    const code = await main({ argv: [], home: () => tmpHome, stdout, stderr });
    expect(code).toBe(0);
    expect(cap.out).toContain("No orchestration runs yet");
    expect(cap.err).toBe("");
  });

  test("empty dir → 'No orchestration runs yet' + exit 0", async () => {
    mkdirSync(join(tmpHome, ".ashlr", "orchestrations"), { recursive: true });
    const { cap, stdout, stderr } = captureFns();
    const code = await main({ argv: [], home: () => tmpHome, stdout, stderr });
    expect(code).toBe(0);
    expect(cap.out).toContain("No orchestration runs yet");
  });

  test("3 fixture runs → table contains all 3 ids + goals", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-aaa", goal: "alpha goal", startedAt: "2027-01-01T00:00:00.000Z" }));
    writeFixture(tmpHome, makeFixture({ id: "g-bbb", goal: "bravo goal", startedAt: "2027-01-02T00:00:00.000Z" }));
    writeFixture(tmpHome, makeFixture({ id: "g-ccc", goal: "charlie goal", startedAt: "2027-01-03T00:00:00.000Z" }));
    const { cap, stdout, stderr } = captureFns();
    const code = await main({ argv: [], home: () => tmpHome, stdout, stderr });
    expect(code).toBe(0);
    expect(cap.out).toContain("g-aaa");
    expect(cap.out).toContain("g-bbb");
    expect(cap.out).toContain("g-ccc");
    expect(cap.out).toContain("alpha goal");
    expect(cap.out).toContain("bravo goal");
    expect(cap.out).toContain("charlie goal");
    expect(cap.out).toContain("3 of 3 runs shown");
  });

  test("sort order: startedAt DESC", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-oldest", goal: "older", startedAt: "2027-01-01T00:00:00.000Z" }));
    writeFixture(tmpHome, makeFixture({ id: "g-newest", goal: "newer", startedAt: "2027-03-01T00:00:00.000Z" }));
    writeFixture(tmpHome, makeFixture({ id: "g-middle", goal: "middle", startedAt: "2027-02-01T00:00:00.000Z" }));
    const { cap, stdout, stderr } = captureFns();
    await main({ argv: [], home: () => tmpHome, stdout, stderr });
    const newestIdx = cap.out.indexOf("g-newest");
    const middleIdx = cap.out.indexOf("g-middle");
    const oldestIdx = cap.out.indexOf("g-oldest");
    expect(newestIdx).toBeGreaterThan(0);
    expect(middleIdx).toBeGreaterThan(newestIdx);
    expect(oldestIdx).toBeGreaterThan(middleIdx);
  });

  test("--last 2 caps the row count", async () => {
    for (const i of [1, 2, 3, 4, 5]) {
      writeFixture(tmpHome, makeFixture({ id: `g-r${i}`, startedAt: `2027-0${i}-01T00:00:00.000Z` }));
    }
    const { cap, stdout, stderr } = captureFns();
    await main({ argv: ["--last", "2"], home: () => tmpHome, stdout, stderr });
    // Newest two are r5, r4; older ids should be omitted from the rows
    // (though "2 of 5 runs shown" footer still references the total).
    expect(cap.out).toContain("g-r5");
    expect(cap.out).toContain("g-r4");
    expect(cap.out).not.toContain("g-r1 ");
    expect(cap.out).toContain("2 of 5 runs shown");
  });

  test("--json with no id → parseable JSON array", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-aaa", startedAt: "2027-01-01T00:00:00.000Z" }));
    writeFixture(tmpHome, makeFixture({ id: "g-bbb", startedAt: "2027-01-02T00:00:00.000Z" }));
    const { cap, stdout, stderr } = captureFns();
    const code = await main({ argv: ["--json"], home: () => tmpHome, stdout, stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].graph.id).toBe("g-bbb");
    expect(parsed[1].graph.id).toBe("g-aaa");
  });

  test("--json on empty dir → JSON empty array", async () => {
    const { cap, stdout, stderr } = captureFns();
    const code = await main({ argv: ["--json"], home: () => tmpHome, stdout, stderr });
    expect(code).toBe(0);
    expect(JSON.parse(cap.out)).toEqual([]);
  });

  test("malformed result.json is skipped with a stderr warning", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-good", startedAt: "2027-01-01T00:00:00.000Z" }));
    const badDir = join(tmpHome, ".ashlr", "orchestrations", "g-bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "result.json"), "{not json");
    const { cap, stdout, stderr } = captureFns();
    const code = await main({ argv: [], home: () => tmpHome, stdout, stderr });
    expect(code).toBe(0);
    expect(cap.out).toContain("g-good");
    expect(cap.out).not.toContain("g-bad ");
    expect(cap.err).toContain("warning");
  });
});

// ---------------------------------------------------------------------------
// main — detail mode
// ---------------------------------------------------------------------------

describe("main — detail mode", () => {
  test("existing id → tree with per-node info", async () => {
    writeFixture(
      tmpHome,
      makeFixture({
        id: "g-detail",
        goal: "build feature X",
        startedAt: "2027-01-15T12:00:00.000Z",
        nodes: [
          { id: "explore", agentKind: "refactorer", ok: true, durationMs: 250, tokens: 1000 },
          { id: "implement", agentKind: "test-writer", ok: true, durationMs: 500, tokens: 2000 },
          { id: "verify", agentKind: "reviewer", ok: false, durationMs: 100, tokens: 0, error: "lint" },
        ],
      }),
    );
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["g-detail"],
      home: () => tmpHome,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(cap.out).toContain("Run g-detail");
    expect(cap.out).toContain("build feature X");
    expect(cap.out).toContain("explore");
    expect(cap.out).toContain("implement");
    expect(cap.out).toContain("verify");
    expect(cap.out).toContain("refactorer");
    expect(cap.out).toContain("test-writer");
    expect(cap.out).toContain("reviewer");
    expect(cap.out).toContain("[fail]");
    expect(cap.out).toContain("lint");
  });

  test("missing id → 'No run found' + exit 1", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-exists", startedAt: "2027-01-01T00:00:00.000Z" }));
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["g-does-not-exist"],
      home: () => tmpHome,
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(cap.err).toContain("No run found with id g-does-not-exist");
  });

  test("path-traversal attempts are rejected before fs lookup", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-real", startedAt: "2027-01-01T00:00:00.000Z" }));
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["../../etc/passwd"],
      home: () => tmpHome,
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(cap.err).toContain("Invalid graph id");
  });

  test("--json <id> → parseable JSON for the single run", async () => {
    writeFixture(tmpHome, makeFixture({ id: "g-json", goal: "json goal", startedAt: "2027-01-01T00:00:00.000Z" }));
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["--json", "g-json"],
      home: () => tmpHome,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out);
    expect(parsed.graph.id).toBe("g-json");
    expect(parsed.graph.goal).toBe("json goal");
  });
});

// ---------------------------------------------------------------------------
// loadRecord / loadAllRecords
// ---------------------------------------------------------------------------

describe("loadRecord + loadAllRecords", () => {
  test("loadRecord returns null for unknown id", () => {
    const warns: string[] = [];
    const rec = loadRecord(tmpHome, "nope", { warn: (s) => warns.push(s) });
    expect(rec).toBeNull();
    expect(warns).toEqual([]); // missing file is silent
  });

  test("loadRecord warns and returns null for malformed JSON", () => {
    const badDir = join(tmpHome, ".ashlr", "orchestrations", "g-bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "result.json"), "{not json");
    const warns: string[] = [];
    const rec = loadRecord(tmpHome, "g-bad", { warn: (s) => warns.push(s) });
    expect(rec).toBeNull();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("warning");
  });

  test("loadAllRecords on missing dir → []", () => {
    const warns: string[] = [];
    expect(loadAllRecords(tmpHome, { warn: (s) => warns.push(s) })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Render snapshots
// ---------------------------------------------------------------------------

describe("renderList", () => {
  test("includes header + footer + every row", () => {
    const recs = [
      makeFixture({ id: "g-1", goal: "one", startedAt: "2027-01-01T00:00:00.000Z" }),
      makeFixture({ id: "g-2", goal: "two", startedAt: "2027-01-02T00:00:00.000Z" }),
    ];
    const out = renderList(recs, 10);
    expect(out).toContain("graph-id");
    expect(out).toContain("startedAt");
    expect(out).toContain("g-1");
    expect(out).toContain("g-2");
    expect(out).toContain("2 of 2 runs shown");
  });

  test("truncates very long goals", () => {
    const long = "x".repeat(200);
    const out = renderList([makeFixture({ id: "g-x", goal: long, startedAt: "2027-01-01T00:00:00.000Z" })], 10);
    expect(out).toContain("…");
  });
});

describe("renderDetail", () => {
  test("renders node tree with branches", () => {
    const rec = makeFixture({
      id: "g-tree",
      goal: "tree goal",
      startedAt: "2027-01-01T00:00:00.000Z",
      nodes: [
        { id: "a", agentKind: "refactorer", ok: true, durationMs: 100, tokens: 500 },
        { id: "b", agentKind: "reviewer", ok: true, durationMs: 200, tokens: 800 },
      ],
    });
    const out = renderDetail(rec);
    expect(out).toContain("Run g-tree");
    expect(out).toContain("├─");
    expect(out).toContain("└─");
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("refactorer");
    expect(out).toContain("reviewer");
  });
});
