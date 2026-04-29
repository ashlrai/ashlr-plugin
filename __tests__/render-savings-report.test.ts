/**
 * Unit tests for the upgraded renderSavings output (three new sections).
 *
 * We test the extra-section helpers directly (savings-report-extras) and
 * exercise the MCP server's ashlr__savings response via rpc() to confirm
 * end-to-end wiring.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  buildTopProjects,
  renderPerProjectSection,
  renderBestDaySection,
  renderCalibrationLine,
  readCalibrationState,
  type ProjectInfo,
} from "../scripts/savings-report-extras";
import type { LifetimeBucket, SessionBucket } from "../servers/_stats";
import { SAVINGS_BANNER, renderSavings } from "../servers/efficiency-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyLifetime(): LifetimeBucket {
  return { calls: 0, tokensSaved: 0, byTool: {}, byDay: {} };
}

function maxLineWidth(text: string): number {
  return Math.max(...text.split("\n").map((l) => l.length));
}

// ---------------------------------------------------------------------------
// renderPerProjectSection
// ---------------------------------------------------------------------------

describe("renderPerProjectSection", () => {
  test("returns empty string when no projects", () => {
    expect(renderPerProjectSection([])).toBe("");
  });

  test("renders heading + one row per project", () => {
    const projects: ProjectInfo[] = [
      { name: "my-app", calls: 42, toolVariety: 3 },
      { name: "other", calls: 5, toolVariety: 1 },
    ];
    const out = renderPerProjectSection(projects);
    expect(out).toContain("top projects");
    expect(out).toContain("my-app");
    expect(out).toContain("42 calls");
    expect(out).toContain("3 tools");
    expect(out).toContain("other");
    expect(out).toContain("1 tool");
  });

  test("truncates long project names", () => {
    const projects: ProjectInfo[] = [
      { name: "a".repeat(60), calls: 1, toolVariety: 1 },
    ];
    const out = renderPerProjectSection(projects);
    expect(maxLineWidth(out)).toBeLessThanOrEqual(80);
  });

  test("width stays <= 80 with typical data", () => {
    const projects: ProjectInfo[] = [
      { name: "ashlr-plugin", calls: 200, toolVariety: 4 },
      { name: "my-web-app", calls: 80, toolVariety: 3 },
      { name: "backend-service", calls: 30, toolVariety: 2 },
    ];
    const out = renderPerProjectSection(projects);
    expect(maxLineWidth(out)).toBeLessThanOrEqual(80);
  });

  test("singular 'call' when calls === 1", () => {
    const projects: ProjectInfo[] = [{ name: "x", calls: 1, toolVariety: 2 }];
    const out = renderPerProjectSection(projects);
    expect(out).toContain("1 call ");
    expect(out).not.toContain("1 calls");
  });
});

// ---------------------------------------------------------------------------
// renderBestDaySection
// ---------------------------------------------------------------------------

describe("renderBestDaySection", () => {
  test("returns empty string when no byDay data", () => {
    expect(renderBestDaySection(emptyLifetime())).toBe("");
  });

  test("shows the best day date and token count", () => {
    const lifetime = emptyLifetime();
    lifetime.byDay["2026-04-10"] = { calls: 5, tokensSaved: 1000 };
    lifetime.byDay["2026-04-11"] = { calls: 20, tokensSaved: 50000 };
    lifetime.byDay["2026-04-12"] = { calls: 8, tokensSaved: 3000 };
    const out = renderBestDaySection(lifetime);
    expect(out).toContain("best day");
    expect(out).toContain("2026-04-11");
    expect(out).toContain("50,000 tok saved");
    expect(out).toContain("20 calls");
  });

  test("shows multiplier relative to recent avg when enough data", () => {
    const lifetime = emptyLifetime();
    lifetime.byDay["2026-04-01"] = { calls: 10, tokensSaved: 2000 };
    lifetime.byDay["2026-04-02"] = { calls: 10, tokensSaved: 2000 };
    lifetime.byDay["2026-04-03"] = { calls: 50, tokensSaved: 20000 }; // best
    const out = renderBestDaySection(lifetime);
    // 20000 / avg(2000,2000) = 10x
    expect(out).toContain("10.0x");
  });

  test("omits multiplier line when only one day of data", () => {
    const lifetime = emptyLifetime();
    lifetime.byDay["2026-04-01"] = { calls: 5, tokensSaved: 5000 };
    const out = renderBestDaySection(lifetime);
    expect(out).not.toContain("avg");
  });

  test("width stays <= 80", () => {
    const lifetime = emptyLifetime();
    lifetime.byDay["2026-04-11"] = { calls: 1000, tokensSaved: 9_999_999 };
    const out = renderBestDaySection(lifetime);
    expect(maxLineWidth(out)).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// renderCalibrationLine
// ---------------------------------------------------------------------------

describe("renderCalibrationLine", () => {
  test("empirical: present=true shows measured ratio", () => {
    const out = renderCalibrationLine(6.3, true);
    expect(out).toContain("empirical");
    expect(out).toContain("6.3x");
    expect(out).not.toContain("estimated");
  });

  test("estimated: present=false shows default 4x and run hint", () => {
    const out = renderCalibrationLine(4, false);
    expect(out).toContain("estimated");
    expect(out).toContain("4x");
    expect(out).toContain("calibrate-grep.ts");
  });

  test("width stays <= 80", () => {
    expect(renderCalibrationLine(4, false).length).toBeLessThanOrEqual(80);
    expect(renderCalibrationLine(12.5, true).length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// buildTopProjects + readCalibrationState (with tmp home)
// ---------------------------------------------------------------------------

describe("buildTopProjects", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-extras-test-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("returns empty array when log absent", () => {
    expect(buildTopProjects(home)).toEqual([]);
  });

  test("parses log and returns top-5 sorted by calls", async () => {
    const records = [
      { ts: new Date().toISOString(), event: "tool_call", tool: "ashlr__read", cwd: "/proj/alpha" },
      { ts: new Date().toISOString(), event: "tool_call", tool: "ashlr__read", cwd: "/proj/alpha" },
      { ts: new Date().toISOString(), event: "tool_call", tool: "ashlr__grep", cwd: "/proj/alpha" },
      { ts: new Date().toISOString(), event: "tool_call", tool: "ashlr__read", cwd: "/proj/beta" },
      { ts: new Date().toISOString(), event: "session_end", tool: "", cwd: "/proj/alpha" },
    ];
    await writeFile(
      join(home, ".ashlr", "session-log.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const projects = buildTopProjects(home);
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects[0]!.name).toBe("alpha");
    expect(projects[0]!.calls).toBe(3);
    expect(projects[0]!.toolVariety).toBe(2); // read + grep
  });

  test("skips session_end records", async () => {
    const records = [
      { ts: new Date().toISOString(), event: "session_end", tool: "", cwd: "/proj/gamma", calls: 10 },
    ];
    await writeFile(
      join(home, ".ashlr", "session-log.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    expect(buildTopProjects(home)).toEqual([]);
  });

  test("reads rotated .1 file as well", async () => {
    const r1 = { ts: new Date().toISOString(), event: "tool_call", tool: "ashlr__read", cwd: "/proj/old" };
    const r2 = { ts: new Date().toISOString(), event: "tool_call", tool: "ashlr__read", cwd: "/proj/new" };
    await writeFile(join(home, ".ashlr", "session-log.jsonl.1"), JSON.stringify(r1) + "\n");
    await writeFile(join(home, ".ashlr", "session-log.jsonl"), JSON.stringify(r2) + "\n");
    const projects = buildTopProjects(home);
    const names = projects.map((p) => p.name);
    expect(names).toContain("old");
    expect(names).toContain("new");
  });
});

// ---------------------------------------------------------------------------
// SAVINGS_BANNER
// ---------------------------------------------------------------------------

describe("SAVINGS_BANNER", () => {
  test("banner is a multi-row block-letter hero with non-empty letter rows", () => {
    const lines = SAVINGS_BANNER.split("\n");
    // 5 letter rows + 1 blank separator + 1 tagline = 7 lines.
    expect(lines.length).toBeGreaterThanOrEqual(5);
    // First five rows are the block-letter hero; each must have content.
    for (let i = 0; i < 5; i++) {
      expect(lines[i]!.trim().length).toBeGreaterThan(0);
    }
  });

  test("every banner line is under 80 visible chars", () => {
    for (const line of SAVINGS_BANNER.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("banner contains 'token-efficient' descriptor", () => {
    expect(SAVINGS_BANNER).toContain("token-efficient");
  });
});

describe("readCalibrationState", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-calib-test-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("present=false when calibration.json absent", () => {
    const calibPath = join(home, ".ashlr", "calibration.json");
    const { present } = readCalibrationState(calibPath);
    expect(present).toBe(false);
  });

  test("present=true and ratio matches file when present", async () => {
    const calibPath = join(home, ".ashlr", "calibration.json");
    await writeFile(calibPath, JSON.stringify({ updatedAt: new Date().toISOString(), meanRatio: 7.2, p50: 7, p90: 9, samples: [] }));
    const { present, ratio } = readCalibrationState(calibPath);
    expect(present).toBe(true);
    expect(ratio).toBeCloseTo(7.2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: all three sections appear in ashlr__savings MCP output
// ---------------------------------------------------------------------------

import { spawn } from "bun";

interface RpcReq { jsonrpc: "2.0"; id: number; method: string; params?: unknown }

async function rpcWithHome(
  reqs: RpcReq[],
  home: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const proc = spawn({
    cmd: ["bun", "run", "servers/efficiency-server.ts"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const responses: Array<{ id: number; result?: any; error?: any }> = [];
  async function waitFor(id: number) {
    while (true) {
      const existing = responses.find((r) => r.id === id);
      if (existing) return existing;
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
  const INIT: RpcReq = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  };
  for (const r of [INIT, ...reqs]) {
    proc.stdin.write(JSON.stringify(r) + "\n");
    await waitFor(r.id);
  }
  await proc.stdin.end();
  await proc.exited;
  return responses;
}

// ---------------------------------------------------------------------------
// renderSavings · today-vs-yesterday callout (parity with /ashlr-dashboard)
// ---------------------------------------------------------------------------

describe("renderSavings · today-vs-yesterday callout", () => {
  function emptySession(): SessionBucket {
    return {
      startedAt: new Date().toISOString(),
      lastSavingAt: null,
      calls: 0,
      tokensSaved: 0,
      byTool: {},
    };
  }
  function makeLifetime(byDay: Record<string, { calls: number; tokensSaved: number }>): LifetimeBucket {
    return { calls: 0, tokensSaved: 0, byTool: {}, byDay };
  }
  function todayAndYesterdayKeys(): { today: string; yesterday: string } {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const y = new Date(now);
    y.setUTCDate(y.getUTCDate() - 1);
    return { today, yesterday: y.toISOString().slice(0, 10) };
  }

  test("today > 1.1x yesterday → callout included with ratio + both token values", () => {
    const { today, yesterday } = todayAndYesterdayKeys();
    const out = renderSavings(
      emptySession(),
      makeLifetime({
        [today]: { calls: 10, tokensSaved: 30000 },
        [yesterday]: { calls: 4, tokensSaved: 10000 },
      }),
    );
    expect(out).toContain("Today's pace is");
    expect(out).toContain("3.0x yesterday");
    expect(out).toContain("30,000");
    expect(out).toContain("10,000");
  });

  test("today < 0.5x yesterday → callout included with 'fewer than yesterday' phrasing", () => {
    const { today, yesterday } = todayAndYesterdayKeys();
    const out = renderSavings(
      emptySession(),
      makeLifetime({
        [today]: { calls: 2, tokensSaved: 2000 },
        [yesterday]: { calls: 20, tokensSaved: 20000 },
      }),
    );
    expect(out).toContain("Today's saved fewer than yesterday");
    expect(out).toContain("2,000");
    expect(out).toContain("20,000");
  });

  test("ratio within quiet band (0.5 < r < 1.1) → no callout, no stray blank lines", () => {
    const { today, yesterday } = todayAndYesterdayKeys();
    const out = renderSavings(
      emptySession(),
      makeLifetime({
        [today]: { calls: 10, tokensSaved: 10500 },
        [yesterday]: { calls: 10, tokensSaved: 10000 },
      }),
    );
    expect(out).not.toContain("Today's pace is");
    expect(out).not.toContain("Today's saved fewer");
    expect(out).not.toContain("great start!");
    // Callout is skipped cleanly: no triple blank line sequence in place of it.
    expect(out).not.toMatch(/\n\n\n\n/);
  });

  test("byDay missing both dates → quiet, no callout", () => {
    const out = renderSavings(emptySession(), makeLifetime({}));
    expect(out).not.toContain("Today's pace is");
    expect(out).not.toContain("Today's saved fewer");
    expect(out).not.toContain("great start!");
  });

  test("yesterday zero + today nonzero → 'great start' callout", () => {
    const { today } = todayAndYesterdayKeys();
    const out = renderSavings(
      emptySession(),
      makeLifetime({ [today]: { calls: 5, tokensSaved: 4200 } }),
    );
    expect(out).toContain("great start!");
    expect(out).toContain("4,200");
  });
});

describe("ashlr__savings e2e — new sections", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-savings-e2e-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function savings(h: string): Promise<string> {
    const responses = await rpcWithHome(
      [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__savings", arguments: {} } }],
      h,
    );
    const r = responses.find((x) => x.id === 2)!;
    return r.result.content[0].text as string;
  }

  test("banner appears exactly once at the top of the output", async () => {
    const text = await savings(home);
    // Strip ANSI before comparing — the banner gets per-row gradient ANSI
    // escapes when truecolor is enabled, so a raw startsWith() against the
    // plain SAVINGS_BANNER constant would fail on the escape prefix.
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
    const bannerFirstLine = SAVINGS_BANNER.split("\n")[0]!;
    const occurrences = stripped.split(bannerFirstLine).length - 1;
    expect(occurrences).toBe(1);
    // Must be the very start of the output (ignoring leading whitespace on the line).
    expect(stripped.trimStart().startsWith(bannerFirstLine.trimStart())).toBe(true);
  });

  test("calibration line always present — estimated when file absent", async () => {
    const text = await savings(home);
    expect(text).toContain("calibration");
    expect(text).toContain("estimated");
  });

  test("calibration line shows empirical when calibration.json present", async () => {
    await writeFile(
      join(home, ".ashlr", "calibration.json"),
      JSON.stringify({ updatedAt: new Date().toISOString(), meanRatio: 5.5, p50: 5, p90: 8, samples: [] }),
    );
    const text = await savings(home);
    expect(text).toContain("calibration");
    expect(text).toContain("empirical");
    expect(text).toContain("5.5x");
  });

  test("best day section appears when byDay has data", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
    await writeFile(
      join(home, ".ashlr", "stats.json"),
      JSON.stringify({
        schemaVersion: 2,
        sessions: {},
        lifetime: {
          calls: 30,
          tokensSaved: 30000,
          byTool: {},
          byDay: {
            [today]: { calls: 10, tokensSaved: 10000 },
            [yesterday]: { calls: 20, tokensSaved: 20000 },
          },
        },
      }),
    );
    const text = await savings(home);
    expect(text).toContain("best day");
    expect(text).toContain(yesterday);
    expect(text).toContain("20,000 tok saved");
  });

  test("per-project section appears when session-log has data", async () => {
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      event: "tool_call",
      tool: "ashlr__read",
      cwd: "/my/cool-project",
    });
    await writeFile(join(home, ".ashlr", "session-log.jsonl"), record + "\n");
    const text = await savings(home);
    expect(text).toContain("top projects");
    expect(text).toContain("cool-project");
  });

  test("per-project section gracefully absent when log missing", async () => {
    const text = await savings(home);
    // Should not crash; project section simply not shown
    expect(text).toContain("ashlr savings");
    expect(text).not.toContain("top projects");
  });

  test("all output lines are <= 80 chars", async () => {
    const text = await savings(home);
    // Strip ANSI before measuring — the banner now ships with per-row 24-bit
    // SGR escapes when truecolor is on, and counting raw .length would inflate
    // every banner row by ~14 bytes per escape.
    const ansiRe = /\x1b\[[0-9;]*m/g;
    const wide = text.split("\n").filter((l) => l.replace(ansiRe, "").length > 80);
    expect(wide).toEqual([]);
  });
});
