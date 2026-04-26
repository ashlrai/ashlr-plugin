/**
 * Tests for the upgraded savings-dashboard.ts
 *
 * Verifies visual-hierarchy contracts:
 *   - Banner appears exactly once
 *   - Tile strip has exactly 3 tiles
 *   - Per-tool bars sort descending; longest bar is full width
 *   - No line exceeds 80 visible cols
 *   - NO_COLOR produces same visible width per line as colored output
 *   - Watch mode skips clear/loop on non-TTY (falls through to single render)
 *   - Empty stats.json → "no savings recorded yet" message
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// We import the render function directly (not via MCP) so tests are fast.
// The module reads stats from a path we can override.
import {
  render,
  visibleWidth,
  fmtTokens,
  fmtUsd,
  loadStats,
  STATS_PATH,
  renderTodayVsYesterday,
  todayYesterdayKeys,
} from "../scripts/savings-dashboard.ts";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      startedAt: new Date().toISOString(),
      calls: 42,
      tokensSaved: 100_000,
      byTool: {
        ashlr__read: { calls: 20, tokensSaved: 60_000 },
        ashlr__edit: { calls: 15, tokensSaved: 35_000 },
        ashlr__grep: { calls: 7, tokensSaved: 5_000 },
      },
    },
    lifetime: {
      calls: 500,
      tokensSaved: 2_500_000,
      byTool: {
        ashlr__read:    { calls: 200, tokensSaved: 1_300_000 },
        ashlr__edit:    { calls: 180, tokensSaved:   900_000 },
        ashlr__grep:    { calls:  60, tokensSaved:   220_000 },
        ashlr__http:    { calls:  10, tokensSaved:    40_000 },
        ashlr__logs:    { calls:   8, tokensSaved:    25_000 },
        ashlr__webfetch:{ calls:   5, tokensSaved:    10_000 },
        ashlr__bash:    { calls:   0, tokensSaved:         0 },
        ashlr__sql:     { calls:   0, tokensSaved:         0 },
      },
      byDay: {
        "2026-04-10": { calls: 20, tokensSaved:  50_000 },
        "2026-04-11": { calls: 50, tokensSaved: 400_000 },
        "2026-04-12": { calls: 30, tokensSaved: 120_000 },
        "2026-04-13": { calls: 25, tokensSaved:  80_000 },
        "2026-04-14": { calls: 40, tokensSaved: 200_000 },
        "2026-04-15": { calls: 60, tokensSaved: 350_000 },
        "2026-04-16": { calls: 35, tokensSaved: 150_000 },
        "2026-04-17": { calls: 55, tokensSaved: 320_000 },
      },
    },
    ...overrides,
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function maxVisibleLineWidth(text: string): number {
  return Math.max(...text.split("\n").map((l) => visibleWidth(l)));
}

// ---------------------------------------------------------------------------
// Banner tests
// ---------------------------------------------------------------------------

describe("banner", () => {
  test("appears exactly once in the output", () => {
    const output = render(makeStats());
    // The middle row of the block-letter hero (`▓▓▓▓    ░▓▓▒    █▓▓▒`) is a
    // unique signature that only appears in the banner — sparkline bars use
    // different glyphs.
    const stripped = stripAnsi(output);
    const bannerSignature = "▓▓▓▓    ░▓▓▒    █▓▓▒";
    expect(stripped.split(bannerSignature).length - 1).toBe(1);
  });

  test("no banner line exceeds 80 cols", () => {
    const output = render(makeStats());
    const bannerLines = stripAnsi(output)
      .split("\n")
      .filter((l) => l.includes("▄") || l.includes("▀") || l.includes("█"));
    for (const line of bannerLines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(80);
    }
  });
});

// ---------------------------------------------------------------------------
// Tile strip tests
// ---------------------------------------------------------------------------

describe("tile strip", () => {
  test("has exactly 3 tile top borders in the output", () => {
    const output = stripAnsi(render(makeStats()));
    // Each tile has a top border with ╭ and a title; count top-corner chars
    // by splitting on lines that contain the tile pattern
    const topLines = output.split("\n").filter((l) => l.includes("╭"));
    // Three tiles are rendered on one row — that single line has 3 ╭ chars
    const tileTopLine = topLines.find((l) => (l.match(/╭/g) ?? []).length === 3);
    expect(tileTopLine).toBeDefined();
    const tileCount = (tileTopLine!.match(/╭/g) ?? []).length;
    expect(tileCount).toBe(3);
  });

  test("tile strip contains session, lifetime, and best day titles", () => {
    const output = stripAnsi(render(makeStats()));
    expect(output).toContain("session");
    expect(output).toContain("lifetime");
    expect(output).toContain("best day");
  });

  test("tile strip shows token counts", () => {
    const output = stripAnsi(render(makeStats()));
    expect(output).toContain(fmtTokens(100_000));  // session
    expect(output).toContain(fmtTokens(2_500_000)); // lifetime
  });
});

// ---------------------------------------------------------------------------
// Per-tool bar chart tests
// ---------------------------------------------------------------------------

describe("per-tool bar chart", () => {
  test("tools appear in descending tokensSaved order", () => {
    const output = stripAnsi(render(makeStats()));
    const chartStart = output.indexOf("per-tool savings");
    expect(chartStart).toBeGreaterThan(-1);
    const chartSection = output.slice(chartStart);
    const readIdx   = chartSection.indexOf("ashlr__read");
    const editIdx   = chartSection.indexOf("ashlr__edit");
    const grepIdx   = chartSection.indexOf("ashlr__grep");
    // read (1.3M) > edit (900K) > grep (220K)
    expect(readIdx).toBeLessThan(editIdx);
    expect(editIdx).toBeLessThan(grepIdx);
  });

  test("tools with 0 tokensSaved are excluded", () => {
    const output = stripAnsi(render(makeStats()));
    const chartStart = output.indexOf("per-tool savings");
    const chartSection = output.slice(chartStart, chartStart + 800);
    // bash and sql both have 0 tokensSaved
    expect(chartSection).not.toContain("ashlr__bash");
    expect(chartSection).not.toContain("ashlr__sql");
  });

  test("at most 8 tools appear", () => {
    // Build a stats with 10 non-zero tools
    const byTool: Record<string, { calls: number; tokensSaved: number }> = {};
    for (let i = 1; i <= 10; i++) {
      byTool[`tool_${i}`] = { calls: i, tokensSaved: i * 10_000 };
    }
    const s = makeStats();
    (s.lifetime as any).byTool = byTool;
    const output = stripAnsi(render(s));
    const chartStart = output.indexOf("per-tool savings");
    const chartEnd = output.indexOf("·", chartStart); // divider
    const chartSection = output.slice(chartStart, chartEnd);
    const toolLines = chartSection.split("\n").filter((l) => l.includes("tool_"));
    expect(toolLines.length).toBeLessThanOrEqual(8);
  });

  test("top tool bar contains 24 block/partial chars (full width)", () => {
    const output = stripAnsi(render(makeStats()));
    const chartStart = output.indexOf("per-tool savings");
    const lines = output.slice(chartStart).split("\n");
    // First tool line (read, highest) should have a full bar — 24 block chars
    const readLine = lines.find((l) => l.includes("ashlr__read"));
    expect(readLine).toBeDefined();
    // Count full-block chars in the bar
    const blockCount = (readLine!.match(/█/g) ?? []).length;
    expect(blockCount).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// Width budget: no line exceeds 80 visible cols
// ---------------------------------------------------------------------------

describe("width budget", () => {
  test("no output line exceeds 80 visible cols with truecolor stats", () => {
    const output = render(makeStats());
    const wide = output.split("\n").filter((l) => visibleWidth(l) > 80);
    expect(wide).toEqual([]);
  });

  test("no output line exceeds 80 visible cols with null stats", () => {
    const output = render(null);
    const wide = output.split("\n").filter((l) => visibleWidth(l) > 80);
    expect(wide).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NO_COLOR: plain-text and colored output have identical visible widths
// ---------------------------------------------------------------------------

describe("NO_COLOR parity", () => {
  test("colored and plain output have identical visible width per line", () => {
    // Render with color (simulate by just calling render — TRUECOLOR detected
    // from env, so in CI without COLORTERM it may already be plain). We test
    // the visibleWidth contract directly.
    const colored = render(makeStats());
    // Build a plain version by stripping ANSI — should have same visible width
    const coloredLines = colored.split("\n");
    for (const line of coloredLines) {
      const plain = stripAnsi(line);
      // visibleWidth should equal plain length (no ANSI escapes)
      expect(visibleWidth(line)).toBe(Array.from(plain).length);
    }
  });
});

// ---------------------------------------------------------------------------
// Empty / null stats
// ---------------------------------------------------------------------------

describe("empty stats", () => {
  test("null stats shows 'no savings recorded yet' message", () => {
    const output = stripAnsi(render(null));
    expect(output).toContain("no savings recorded yet");
    expect(output).toContain("ashlr-demo");
  });

  test("null stats still renders the banner", () => {
    const output = stripAnsi(render(null));
    // Tagline is part of the banner and contains "token-efficiency"; the
    // block-letter hero rows themselves don't spell ASCII "ashlr" (block art).
    expect(output).toContain("token-efficiency layer for claude code");
  });

  test("null stats: no line exceeds 80 cols", () => {
    const output = render(null);
    const wide = output.split("\n").filter((l) => visibleWidth(l) > 80);
    expect(wide).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sparklines
// ---------------------------------------------------------------------------

describe("sparklines", () => {
  test("last 7d and last 30d labels appear", () => {
    const output = stripAnsi(render(makeStats()));
    expect(output).toContain("last 7d");
    expect(output).toContain("last 30d");
  });

  test("30d sparkline has at most 20 glyph cells", () => {
    const output = stripAnsi(render(makeStats()));
    const sparkStart = output.indexOf("last 30d");
    const sparkLine = output.slice(sparkStart).split("\n")[0]!;
    // Count block glyphs on the sparkline line (▁▂▃▄▅▆▇█)
    const glyphs = (sparkLine.match(/[▁▂▃▄▅▆▇█]/g) ?? []).length;
    expect(glyphs).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Projected annual
// ---------------------------------------------------------------------------

describe("projection", () => {
  test("projection section appears when ≥3 active days in last 30", () => {
    const output = stripAnsi(render(makeStats()));
    expect(output).toContain("projected annual savings");
    expect(output).toContain("tok/yr");
    expect(output).toContain("projection based on last 30d average");
  });

  test("not enough history message shown when <3 active days", () => {
    const s = makeStats();
    (s.lifetime as any).byDay = { "2026-04-17": { calls: 10, tokensSaved: 1000 } };
    const output = stripAnsi(render(s));
    expect(output).toContain("not enough history");
  });
});

// ---------------------------------------------------------------------------
// Watch mode: exits immediately on non-TTY (single render)
// ---------------------------------------------------------------------------

describe("watch mode (non-TTY passthrough)", () => {
  test("--watch flag with non-TTY stdin produces a single render and exits", async () => {
    const { spawn } = await import("bun");
    const { join, resolve } = await import("path");
    // Resolve the script path relative to this test file so the test runs on
    // any machine (the old hardcoded absolute was a dev-machine-only path).
    const scriptPath = resolve(import.meta.dir, "..", "scripts", "savings-dashboard.ts");
    const proc = spawn({
      cmd: ["bun", "run", scriptPath, "--watch"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Not a TTY — isTTY will be false on the spawned proc's stdin
    });
    // Close stdin immediately to simulate non-TTY close
    await proc.stdin.end();
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();
    // Should have exited cleanly (0) and produced banner output
    expect(exitCode).toBe(0);
    expect(out.length).toBeGreaterThan(10);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Formatters (unit)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Today-vs-yesterday callout (v1.18.1)
// ---------------------------------------------------------------------------

describe("today-vs-yesterday callout", () => {
  // Fix "now" so tests are deterministic regardless of UTC drift between
  // test machine and CI. We pick a mid-day UTC timestamp so ISO slicing to
  // YYYY-MM-DD is unambiguous.
  const FIXED_NOW = new Date("2026-04-23T12:00:00Z");
  const { today, yesterday } = todayYesterdayKeys(FIXED_NOW);

  test("today saved more: shows 'Today's pace is N.Nx' with both values", () => {
    const byDay = {
      [yesterday]: { calls: 10, tokensSaved: 100_000 },
      [today]:     { calls: 15, tokensSaved: 250_000 },  // 2.5x
    };
    const out = stripAnsi(renderTodayVsYesterday(byDay, FIXED_NOW));
    expect(out).toContain("Today's pace is 2.5x yesterday's");
    expect(out).toContain("250.0K");
    expect(out).toContain("100.0K");
    // Must be a single line.
    expect(out.includes("\n")).toBe(false);
  });

  test("today saved less: shows less-active message with both values", () => {
    const byDay = {
      [yesterday]: { calls: 60, tokensSaved: 400_000 },
      [today]:     { calls: 10, tokensSaved:  80_000 },  // 0.2x
    };
    const out = stripAnsi(renderTodayVsYesterday(byDay, FIXED_NOW));
    expect(out).toContain("Today's saved fewer than yesterday");
    expect(out).toContain("80.0K");
    expect(out).toContain("400.0K");
    expect(out).toContain("less active session?");
    expect(out.includes("\n")).toBe(false);
  });

  test("yesterday zero + today nonzero: 'great start' message", () => {
    const byDay = {
      [today]: { calls: 5, tokensSaved: 42_000 },
    };
    const out = stripAnsi(renderTodayVsYesterday(byDay, FIXED_NOW));
    expect(out).toContain("Saved 42.0K tokens today");
    expect(out).toContain("great start!");
    expect(out.includes("\n")).toBe(false);
  });

  test("both zero: no callout", () => {
    const byDay = {
      [yesterday]: { calls: 0, tokensSaved: 0 },
      [today]:     { calls: 0, tokensSaved: 0 },
    };
    expect(renderTodayVsYesterday(byDay, FIXED_NOW)).toBe("");
  });

  test("completely empty byDay: no callout", () => {
    expect(renderTodayVsYesterday({}, FIXED_NOW)).toBe("");
  });

  test("ratio within 10% (quiet zone): no callout", () => {
    // 105K vs 100K → ratio = 1.05, within [0.5, 1.1) → quiet
    const byDay = {
      [yesterday]: { calls: 10, tokensSaved: 100_000 },
      [today]:     { calls: 11, tokensSaved: 105_000 },
    };
    expect(renderTodayVsYesterday(byDay, FIXED_NOW)).toBe("");
  });

  test("ratio exactly 1.0: no callout (quiet)", () => {
    const byDay = {
      [yesterday]: { calls: 10, tokensSaved: 100_000 },
      [today]:     { calls: 10, tokensSaved: 100_000 },
    };
    expect(renderTodayVsYesterday(byDay, FIXED_NOW)).toBe("");
  });

  test("ratio at boundary 1.1 fires the up callout", () => {
    const byDay = {
      [yesterday]: { calls: 10, tokensSaved: 100_000 },
      [today]:     { calls: 11, tokensSaved: 110_000 },
    };
    const out = stripAnsi(renderTodayVsYesterday(byDay, FIXED_NOW));
    expect(out).toContain("Today's pace is 1.1x yesterday's");
  });

  test("ratio at boundary 0.5 fires the down callout", () => {
    const byDay = {
      [yesterday]: { calls: 20, tokensSaved: 200_000 },
      [today]:     { calls:  5, tokensSaved: 100_000 },
    };
    const out = stripAnsi(renderTodayVsYesterday(byDay, FIXED_NOW));
    expect(out).toContain("Today's saved fewer than yesterday");
  });

  test("uses UTC dates, not local", () => {
    // todayYesterdayKeys must always produce ISO UTC slices regardless of TZ.
    const t = new Date("2026-01-01T00:30:00Z"); // early-morning UTC
    const keys = todayYesterdayKeys(t);
    expect(keys.today).toBe("2026-01-01");
    expect(keys.yesterday).toBe("2025-12-31");
  });

  test("render() surfaces the callout near the top when data warrants", () => {
    // Build stats where today beats yesterday convincingly.
    const { today: t, yesterday: y } = todayYesterdayKeys();
    const s = makeStats();
    (s.lifetime as any).byDay = {
      ...(s.lifetime as any).byDay,
      [y]: { calls: 10, tokensSaved: 100_000 },
      [t]: { calls: 20, tokensSaved: 300_000 },
    };
    const stripped = stripAnsi(render(s));
    const calloutIdx = stripped.indexOf("Today's pace is");
    const tileIdx = stripped.indexOf("session");
    // Callout must appear, and must appear before the tile strip.
    expect(calloutIdx).toBeGreaterThan(-1);
    expect(tileIdx).toBeGreaterThan(-1);
    expect(calloutIdx).toBeLessThan(tileIdx);
  });

  test("render() stays quiet when today/yesterday are absent (cold start)", () => {
    const s = makeStats();
    // Strip byDay entirely — no data for today/yesterday.
    (s.lifetime as any).byDay = {};
    const stripped = stripAnsi(render(s));
    expect(stripped).not.toContain("Today's pace is");
    expect(stripped).not.toContain("Saved ");
    expect(stripped).not.toContain("less active session?");
    // Must not print any "0x" or "undefined" accidental rendering.
    expect(stripped).not.toContain("0.0x");
    expect(stripped).not.toContain("undefined");
  });

  test("callout line does not bust the 80-col budget", () => {
    // Use very large values to stress the token formatter width.
    const byDay = {
      [yesterday]: { calls: 999, tokensSaved:  9_999_999 },
      [today]:     { calls: 999, tokensSaved: 99_999_999 },
    };
    const line = renderTodayVsYesterday(byDay, FIXED_NOW);
    expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });
});

describe("fmtTokens", () => {
  test("formats sub-thousand as integer", () => {
    expect(fmtTokens(500)).toBe("500");
  });
  test("formats thousands as K", () => {
    expect(fmtTokens(1500)).toBe("1.5K");
  });
  test("formats millions as M", () => {
    expect(fmtTokens(2_500_000)).toBe("2.50M");
  });
});

describe("fmtUsd", () => {
  // v1.18: dashboard + efficiency-server share servers/_pricing.ts.
  // v1.22: default model is sonnet-4.6 input ($2.50/MTok). Pin to sonnet-4.5
  // ($3/MTok) so this test stays deterministic across future default model
  // bumps; the formatting rules (4dp vs 2dp) are what's under test, not the
  // current rate.
  let priorPricing: string | undefined;
  beforeEach(() => {
    priorPricing = process.env.ASHLR_PRICING_MODEL;
    process.env.ASHLR_PRICING_MODEL = "sonnet-4.5";
  });
  afterEach(() => {
    if (priorPricing === undefined) delete process.env.ASHLR_PRICING_MODEL;
    else process.env.ASHLR_PRICING_MODEL = priorPricing;
  });
  test("formats small amounts with 4 dp when < $0.01", () => {
    expect(fmtUsd(1000)).toBe("~$0.0030");
  });
  test("formats larger amounts with 2 dp", () => {
    const out = fmtUsd(1_000_000);
    expect(out).toBe("~$3.00");
  });
});

// ---------------------------------------------------------------------------
// Hook performance section in dashboard
// ---------------------------------------------------------------------------

describe("hook performance section", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ashlr-dash-hooks-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("dashboard contains 'hook performance' when timings file has records", async () => {
    // Seed a hook-timings.jsonl in tmpDir
    const now = new Date().toISOString();
    const records = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ ts: now, hook: `hook-${i}`, tool: null, durationMs: (i + 1) * 20, outcome: "ok" })
    ).join("\n") + "\n";
    await writeFile(join(tmpDir, "hook-timings.jsonl"), records, "utf-8");

    const output = stripAnsi(render(makeStats(), tmpDir));
    expect(output).toContain("hook performance");
  });

  test("dashboard omits hook performance section when timings file is missing", async () => {
    // tmpDir has no hook-timings.jsonl
    const output = stripAnsi(render(makeStats(), tmpDir));
    expect(output).not.toContain("hook performance");
  });

  test("dashboard omits hook performance section when timings file is empty", async () => {
    await writeFile(join(tmpDir, "hook-timings.jsonl"), "", "utf-8");
    const output = stripAnsi(render(makeStats(), tmpDir));
    expect(output).not.toContain("hook performance");
  });
});

describe("nudge section", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "ashlr-dash-nudge-"));
    await mkdir(join(tmpHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  test("shows 'pro upgrade nudge' with rate when jsonl has shown+clicked events", async () => {
    const events = [
      { event: "nudge_shown", sessionId: "s1", tokenCount: 50_000, variant: "v1", nudgeId: "n1", ts: "2026-04-22T00:00:00Z" },
      { event: "nudge_shown", sessionId: "s2", tokenCount: 50_000, variant: "v1", nudgeId: "n2", ts: "2026-04-22T01:00:00Z" },
      { event: "nudge_shown", sessionId: "s3", tokenCount: 50_000, variant: "v1", nudgeId: "n3", ts: "2026-04-22T02:00:00Z" },
      { event: "nudge_shown", sessionId: "s4", tokenCount: 50_000, variant: "v1", nudgeId: "n4", ts: "2026-04-22T03:00:00Z" },
      { event: "nudge_clicked", sessionId: "s1", tokenCount: 50_000, variant: "v1", nudgeId: "n1", ts: "2026-04-22T00:05:00Z" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "nudge-events.jsonl"), events, "utf-8");

    const output = stripAnsi(render(makeStats(), tmpHome));
    expect(output).toContain("pro upgrade nudge:");
    expect(output).toContain("shown 4");
    expect(output).toContain("clicked 1");
    expect(output).toContain("25.0%");
  });

  test("relabels section as historical for pro users", async () => {
    await writeFile(join(tmpHome, ".ashlr", "pro-token"), "pro-abc-123", "utf-8");
    const events = [
      { event: "nudge_shown", sessionId: "s1", tokenCount: 50_000, variant: "v1", nudgeId: "n1", ts: "2026-04-22T00:00:00Z" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "nudge-events.jsonl"), events, "utf-8");

    const output = stripAnsi(render(makeStats(), tmpHome));
    expect(output).toContain("pro upgrade (historical nudge stats):");
    expect(output).not.toContain("pro upgrade nudge:");
  });

  test("omits section when events jsonl is absent", async () => {
    const output = stripAnsi(render(makeStats(), tmpHome));
    expect(output).not.toContain("pro upgrade nudge");
    expect(output).not.toContain("pro upgrade (historical");
  });

  test("shows dismissed line when events include dismissals", async () => {
    const events = [
      { event: "nudge_shown", sessionId: "s1", tokenCount: 50_000, variant: "v1", nudgeId: "n1", ts: "2026-04-22T00:00:00Z" },
      { event: "nudge_dismissed_implicitly", sessionId: "s1", tokenCount: 50_000, variant: "v1", nudgeId: "n1", ts: "2026-04-22T00:30:00Z" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "nudge-events.jsonl"), events, "utf-8");

    const output = stripAnsi(render(makeStats(), tmpHome));
    expect(output).toContain("dismissed (session ended, no click): 1");
  });
});

// ---------------------------------------------------------------------------
// Track G: "Where savings come from" section
// ---------------------------------------------------------------------------

import {
  renderSavingsMechanisms,
  renderAdoptionFunnel,
  readSessionLog,
} from "../scripts/savings-dashboard.ts";

describe("where savings come from section", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "ashlr-dash-mechanisms-"));
    await mkdir(join(tmpHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  test("renders empty-state hint when no session log", () => {
    const lines = renderSavingsMechanisms(tmpHome);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("where savings come from");
    expect(text).toContain("no data");
  });

  test("renders genome mechanism when genome_route_taken events present", async () => {
    const events = [
      { event: "genome_route_taken", tool: "ashlr__grep", ts: new Date().toISOString(), sectionsRetrieved: 3 },
      { event: "genome_route_taken", tool: "ashlr__grep", ts: new Date().toISOString(), sectionsRetrieved: 2 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), events, "utf-8");

    const lines = renderSavingsMechanisms(tmpHome);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("where savings come from");
    expect(text).toContain("genome");
  });

  test("renders LLM-anthropic when llm_summarize_provider_used events present", async () => {
    const events = [
      { event: "llm_summarize_provider_used", tool: "ashlr__read", ts: new Date().toISOString(), provider: "anthropic", in_tokens: 2000, out_tokens: 200 },
      { event: "llm_summarize_provider_used", tool: "ashlr__read", ts: new Date().toISOString(), provider: "anthropic", in_tokens: 3000, out_tokens: 300 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), events, "utf-8");

    const lines = renderSavingsMechanisms(tmpHome);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("LLM-anthropic");
  });

  test("renders embed-cache when embed_cache_hit events present", async () => {
    const events = [
      { event: "embed_cache_hit", tool: "ashlr__grep", ts: new Date().toISOString(), tokensSaved: 450, topSimilarity: 0.85 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), events, "utf-8");

    const lines = renderSavingsMechanisms(tmpHome);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("embed-cache");
  });

  test("no line exceeds 80 cols", async () => {
    const events = [
      { event: "genome_route_taken", tool: "ashlr__grep", ts: new Date().toISOString(), sectionsRetrieved: 5 },
      { event: "llm_summarize_provider_used", tool: "ashlr__read", ts: new Date().toISOString(), provider: "anthropic", in_tokens: 5000, out_tokens: 500 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), events, "utf-8");

    const lines = renderSavingsMechanisms(tmpHome);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("mechanisms section appears in full render output", async () => {
    const events = [
      { event: "genome_route_taken", tool: "ashlr__grep", ts: new Date().toISOString(), sectionsRetrieved: 2 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), events, "utf-8");

    const output = stripAnsi(render(makeStats(), tmpHome));
    expect(output).toContain("where savings come from");
  });
});

// ---------------------------------------------------------------------------
// Track G: "Adoption funnel" section
// ---------------------------------------------------------------------------

describe("adoption funnel section", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "ashlr-dash-funnel-"));
    await mkdir(join(tmpHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  test("renders empty-state hint when no data", () => {
    const lines = renderAdoptionFunnel(tmpHome);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("adoption funnel");
    expect(text).toContain("no data");
  });

  test("shows blocks emitted from hook-timings + conversions from session-log", async () => {
    // Write hook-timings with block outcomes
    const now = new Date().toISOString();
    const timings = [
      { ts: now, hook: "pretooluse-grep", tool: "Grep", durationMs: 5, outcome: "block" },
      { ts: now, hook: "pretooluse-grep", tool: "Grep", durationMs: 4, outcome: "block" },
      { ts: now, hook: "pretooluse-read", tool: "Read", durationMs: 3, outcome: "ok" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "hook-timings.jsonl"), timings, "utf-8");

    // Write session-log with correlation events
    const sessionEvents = [
      { event: "tool_called_after_block", tool: "ashlr__grep", ts: now, nativeToolBlocked: "Grep", latencyMs: 3000 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), sessionEvents, "utf-8");

    const lines = renderAdoptionFunnel(tmpHome);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("adoption funnel");
    expect(text).toContain("blocks emitted");
    expect(text).toContain("2"); // 2 blocks
    expect(text).toContain("conversion rate");
  });

  test("no line exceeds 80 cols", async () => {
    const now = new Date().toISOString();
    const timings = Array.from({ length: 10 }, () =>
      JSON.stringify({ ts: now, hook: "pretooluse-grep", tool: "Grep", durationMs: 5, outcome: "block" })
    ).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "hook-timings.jsonl"), timings, "utf-8");

    const lines = renderAdoptionFunnel(tmpHome);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("funnel section appears in full render output", async () => {
    const output = stripAnsi(render(makeStats(), tmpHome));
    expect(output).toContain("adoption funnel");
  });
});

// ---------------------------------------------------------------------------
// Track G: readSessionLog helper
// ---------------------------------------------------------------------------

describe("readSessionLog", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "ashlr-sessionlog-"));
    await mkdir(join(tmpHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array when file absent", () => {
    const records = readSessionLog(tmpHome);
    expect(records).toEqual([]);
  });

  test("parses JSONL records correctly", async () => {
    const events = [
      { event: "genome_route_taken", tool: "ashlr__grep", ts: new Date().toISOString(), sectionsRetrieved: 3 },
      { event: "embed_cache_hit", tool: "ashlr__grep", ts: new Date().toISOString(), tokensSaved: 200 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), events, "utf-8");

    const records = readSessionLog(tmpHome);
    expect(records.length).toBe(2);
    expect(records[0]!.event).toBe("genome_route_taken");
    expect(records[1]!.event).toBe("embed_cache_hit");
  });

  test("skips malformed lines gracefully", async () => {
    const content = [
      JSON.stringify({ event: "genome_route_taken", tool: "ashlr__grep", ts: new Date().toISOString() }),
      "{ not valid json %%%",
      JSON.stringify({ event: "embed_cache_miss", tool: "ashlr__grep", ts: new Date().toISOString() }),
    ].join("\n") + "\n";
    await writeFile(join(tmpHome, ".ashlr", "session-log.jsonl"), content, "utf-8");

    const records = readSessionLog(tmpHome);
    expect(records.length).toBe(2);
  });
});
