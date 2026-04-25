/**
 * Unit tests for the ashlr status-line composer.
 *
 * We exercise buildStatusLine() with a synthetic HOME so each case gets an
 * isolated filesystem. No real ~/.ashlr or ~/.claude is read.
 *
 * All tests pass a deterministic `env` (no ANSI color, fixed session id)
 * so assertions work regardless of the developer's real terminal
 * capabilities.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildStatusLine, extractContextPct, formatTokens, renderSparkline } from "../scripts/savings-status-line";

let home: string;

// Fixed session id so tests control exactly which bucket is read.
const SID = "test-session";
// Baseline env: no color, no animation, known session id. Tests that need
// more (e.g. COLUMNS=120) merge into this.
//   ASHLR_DISABLE_MILESTONES=1 silences the 10k celebration by default so
//   existing tests don't pollute stderr; milestone-specific tests opt-in by
//   clearing that var.
const BASE_ENV = Object.freeze({
  NO_COLOR: "1",
  ASHLR_STATUS_ANIMATE: "0",
  CLAUDE_SESSION_ID: SID,
  COLUMNS: "80",
  ASHLR_DISABLE_MILESTONES: "1",
}) as Readonly<NodeJS.ProcessEnv>;

function envWith(extras: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...extras };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-statusline-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface V2TestStats {
  sessionTokensSaved?: number;
  sessionCalls?: number;
  lifetimeTokensSaved?: number;
  lifetimeCalls?: number;
  byDay?: Record<string, { calls?: number; tokensSaved?: number }>;
}

async function writeStats(s: V2TestStats): Promise<void> {
  const payload = {
    schemaVersion: 2,
    sessions: {
      [SID]: {
        startedAt: new Date().toISOString(),
        lastSavingAt: null,
        calls: s.sessionCalls ?? 0,
        tokensSaved: s.sessionTokensSaved ?? 0,
        byTool: {},
      },
    },
    lifetime: {
      calls: s.lifetimeCalls ?? 0,
      tokensSaved: s.lifetimeTokensSaved ?? 0,
      byTool: {},
      byDay: s.byDay ?? {},
    },
  };
  await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(payload));
}

async function writeSettings(ashlr: unknown): Promise<void> {
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ ashlr }));
}

describe("formatTokens", () => {
  test("under 1k stays integer", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands → K with one decimal", () => {
    expect(formatTokens(1234)).toBe("1.2K");
    expect(formatTokens(12_345)).toBe("12.3K");
  });

  test("millions → M with one decimal", () => {
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});

describe("extractContextPct", () => {
  test("returns null for null/undefined input", () => {
    expect(extractContextPct(null)).toBeNull();
    expect(extractContextPct(undefined)).toBeNull();
  });

  test("returns null when no usable fields", () => {
    expect(extractContextPct({})).toBeNull();
    expect(extractContextPct({ input_tokens: 5000 })).toBeNull();
  });

  test("context_used_tokens + context_limit_tokens → correct pct", () => {
    expect(extractContextPct({ context_used_tokens: 50_000, context_limit_tokens: 100_000 })).toBe(50);
  });

  test("caps at 100 when used > limit", () => {
    expect(extractContextPct({ context_used_tokens: 120_000, context_limit_tokens: 100_000 })).toBe(100);
  });

  test("returns null when context_limit_tokens is 0", () => {
    expect(extractContextPct({ context_used_tokens: 1000, context_limit_tokens: 0 })).toBeNull();
  });
});

describe("buildStatusLine", () => {
  test("no stats file, no settings → waiting-for-first-tool-call state", () => {
    // No stats file: plugin hasn't been used yet. Show a distinct message.
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line.startsWith("ashlr")).toBe(true);
    expect(line).toContain("waiting for first tool call");
    expect(line).not.toContain("session +0");
    expect(line.length).toBeLessThanOrEqual(80);
  });

  test("stats present → formatted with K/M units", async () => {
    await writeStats({ sessionTokensSaved: 12_345, sessionCalls: 4, lifetimeTokensSaved: 1_240_000, lifetimeCalls: 100 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line).toContain("session +12.3K");
    expect(line).toContain("lifetime +1.2M");
  });

  test("statusLine: false → empty string", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 1000 , lifetimeCalls: 10 });
    await writeSettings({ statusLine: false });
    expect(buildStatusLine({ home, env: envWith() })).toBe("");
  });

  test("statusLineSession: false → lifetime only", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 5000 , lifetimeCalls: 10 });
    await writeSettings({ statusLineSession: false, statusLineTips: false });
    const line = buildStatusLine({ home, env: envWith() });
    expect(line).not.toContain("session");
    expect(line).toContain("lifetime +5.0K");
  });

  test("statusLineLifetime: false → session only", async () => {
    await writeStats({ sessionTokensSaved: 2000, lifetimeTokensSaved: 5000 , lifetimeCalls: 10 });
    await writeSettings({ statusLineLifetime: false, statusLineTips: false });
    const line = buildStatusLine({ home, env: envWith() });
    expect(line).toContain("session +2.0K");
    expect(line).not.toContain("lifetime");
  });

  test("tips disabled → no 'tip:' segment", async () => {
    await writeSettings({ statusLineTips: false });
    const line = buildStatusLine({ home, env: envWith() });
    expect(line).not.toContain("tip:");
  });

  test("tips enabled → tip segment appears (when it fits)", async () => {
    await writeStats({ sessionTokensSaved: 10, lifetimeTokensSaved: 10 , lifetimeCalls: 10 });
    // Generous budget so any tip fits.
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith({ COLUMNS: "120" }) });
    expect(line).toContain("tip:");
  });

  test("corrupt stats.json → graceful fallback, no exception", async () => {
    await writeFile(join(home, ".ashlr", "stats.json"), "{not json");
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line.startsWith("ashlr")).toBe(true);
    expect(line).toContain("session +0");
  });

  test("corrupt settings.json → graceful fallback to defaults", async () => {
    await writeFile(join(home, ".claude", "settings.json"), "{broken");
    await writeStats({ sessionTokensSaved: 7, lifetimeTokensSaved: 9 , lifetimeCalls: 10 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line).toContain("session +7");
    expect(line).toContain("lifetime +9");
  });

  test("sparkline renders between brand and session", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await writeStats({
      sessionTokensSaved: 12_300,
      lifetimeTokensSaved: 1_240_000,
      byDay: { [today]: { calls: 5, tokensSaved: 50_000 } },
    });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    // New format includes a heartbeat glyph (·) before the sparkline.
    // Shape: "ashlr <heartbeat> <7-char spark> · session …"
    // Sparkline ramp is 16-rung — braille + unicode block chars.
    expect(line).toMatch(/^ashlr [\u00B7\u0024-\u007E\u2800-\u28FF] /);
    expect(line).toContain("· session");
    expect(line.length).toBeLessThanOrEqual(80);
  });

  test("sparkline off removes the sparkline segment", async () => {
    await writeStats({
      sessionTokensSaved: 12_300,
      lifetimeTokensSaved: 1_240_000,
      byDay: { "2020-01-01": { calls: 5, tokensSaved: 50_000 } },
    });
    await writeSettings({ statusLineSparkline: false });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line.startsWith("ashlr · ")).toBe(true);
    // No Braille glyphs anywhere in the line.
    expect(/[\u2800-\u28FF]/.test(line)).toBe(false);
  });

  test("renderSparkline (legacy helper): chars scale relative to busiest day", () => {
    const now = new Date();
    const day = (offset: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    const byDay = {
      [day(0)]: { tokensSaved: 1000 },
      [day(1)]: { tokensSaved: 500 },
    };
    const spark = renderSparkline(byDay, 7);
    expect(spark.length).toBe(7);
    for (const ch of spark) expect(ch.codePointAt(0)! >= 0x2800 && ch.codePointAt(0)! <= 0x28FF).toBe(true);
    expect(spark[6]).toBe("\u28FF");
    expect(spark[5]).not.toBe("\u2800");
    expect(spark[5]).not.toBe("\u28FF");
    expect(spark[0]).toBe("\u2800");
  });

  test("renderSparkline (legacy helper): empty byDay yields all-blank", () => {
    expect(renderSparkline(undefined, 7)).toBe("\u2800".repeat(7));
    expect(renderSparkline({}, 7)).toBe("\u2800".repeat(7));
  });

  test("output stays within 80 chars", async () => {
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 , lifetimeCalls: 10 });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({ home, tipSeed: i, env: envWith() });
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("wide terminal ($COLUMNS=120) → full tip renders", async () => {
    // Keep session tokens below the 50k upgrade-nudge threshold so the
    // rotating tip — not the nudge — lands at the end of the line.
    await writeStats({ sessionTokensSaved: 10_000, lifetimeTokensSaved: 999_999 , lifetimeCalls: 10 });
    // tipSeed: 6 targets "savings persist in ~/.ashlr/stats.json"
    const line = buildStatusLine({ home, tipSeed: 6, env: envWith({ COLUMNS: "120" }) });
    expect(line).toContain("tip: savings persist in ~/.ashlr/stats.json");
    expect(line.length).toBeLessThanOrEqual(120);
  });

  test("free user with ≥50k session tokens → upgrade nudge replaces tip", async () => {
    await writeStats({ sessionTokensSaved: 75_000, lifetimeTokensSaved: 999_999 , lifetimeCalls: 10 });
    const line = buildStatusLine({ home, tipSeed: 6, env: envWith(), budget: 200, suppressNudgeTelemetry: true });
    expect(line).toContain("↑:");
    expect(line).toMatch(/50k\+ saved/);
    expect(line).toContain("/ashlr-upgrade");
    expect(line).not.toContain("tip: savings persist");
  });

  test("pro user (pro-token present) → nudge suppressed", async () => {
    await writeStats({ sessionTokensSaved: 75_000, lifetimeTokensSaved: 999_999 , lifetimeCalls: 10 });
    await mkdir(join(home, ".ashlr"), { recursive: true });
    await writeFile(join(home, ".ashlr", "pro-token"), "pro-123456");
    const line = buildStatusLine({ home, tipSeed: 6, env: envWith(), budget: 200 });
    expect(line).not.toContain("↑:");
    expect(line).toContain("tip: savings persist in ~/.ashlr/stats.json");
  });

  test("statusLineUpgradeNudge:false silences the nudge", async () => {
    await writeStats({ sessionTokensSaved: 75_000, lifetimeTokensSaved: 999_999 , lifetimeCalls: 10 });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ ashlr: { statusLineUpgradeNudge: false } }),
    );
    const line = buildStatusLine({ home, tipSeed: 6, env: envWith(), budget: 200 });
    expect(line).not.toContain("↑:");
    expect(line).toContain("tip: savings persist in ~/.ashlr/stats.json");
  });

  test("80-col terminal with long numbers → tip dropped cleanly, no mid-word truncation", async () => {
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 , lifetimeCalls: 10 });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({ home, tipSeed: i, env: envWith() });
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/tip: [^·]*…/);
    }
  });

  test("default $COLUMNS unset → falls back to 80 budget", async () => {
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 , lifetimeCalls: 10 });
    const line = buildStatusLine({ home, tipSeed: 0, env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: SID } });
    expect(line.length).toBeLessThanOrEqual(80);
  });

  // -------------------------------------------------------------------------
  // Context-pressure widget
  // -------------------------------------------------------------------------

  test("ctx widget renders when statusLineInput carries context_used/limit tokens", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: envWith({ COLUMNS: "120" }),
      statusLineInput: { context_used_tokens: 50_000, context_limit_tokens: 100_000 },
    });
    expect(line).toContain("ctx: 50%");
  });

  test("ctx widget hidden when no statusLineInput", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line).not.toContain("ctx:");
  });

  test("ctx widget hidden when statusLineInput is null", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith(), statusLineInput: null });
    expect(line).not.toContain("ctx:");
  });

  test("ctx widget hidden when statusLineInput has no usable fields", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const line = buildStatusLine({
      home, tipSeed: 0, env: envWith(),
      statusLineInput: { input_tokens: 5000 }, // no limit field → cannot compute pct
    });
    expect(line).not.toContain("ctx:");
  });

  test("ctx widget appears between sparkline+brand and session segment", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: envWith({ COLUMNS: "120" }),
      statusLineInput: { context_used_tokens: 75_000, context_limit_tokens: 100_000 },
    });
    // Positions: brand…sparkline < ctx: < session +N
    const ctxPos     = line.indexOf("ctx:");
    const sessionPos = line.indexOf("session");
    expect(ctxPos).toBeGreaterThan(0);
    expect(ctxPos).toBeLessThan(sessionPos);
  });

  test("ctx widget counts toward budget (visibleWidth)", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const withCtx = buildStatusLine({
      home, tipSeed: 0, env: envWith({ COLUMNS: "120" }),
      statusLineInput: { context_used_tokens: 50_000, context_limit_tokens: 100_000 },
    });
    const withoutCtx = buildStatusLine({
      home, tipSeed: 0, env: envWith({ COLUMNS: "120" }),
    });
    // Strip ANSI to get visible widths.
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const wWith    = Array.from(stripAnsi(withCtx)).length;
    const wWithout = Array.from(stripAnsi(withoutCtx)).length;
    // With ctx widget present, line is wider (widget is ~9 chars + separator).
    expect(wWith).toBeGreaterThan(wWithout);
  });

  test("drop-order: tip dropped before ctx widget under tight budget", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    // Use a constrained budget that forces something to drop.
    // At 60 cols the tip (longest ~45 chars) should drop first; ctx (9 chars) survives.
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: envWith({ COLUMNS: "60" }),
      statusLineInput: { context_used_tokens: 50_000, context_limit_tokens: 100_000 },
    });
    // Tip should be absent; ctx widget should still be present.
    expect(line).not.toContain("tip:");
    expect(line).toContain("ctx:");
  });

  test("drop-order: ctx widget dropped when even core line exceeds budget", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    // Extremely narrow terminal — even brand + session + ctx won't fit.
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: envWith({ COLUMNS: "30" }),
      statusLineInput: { context_used_tokens: 90_000, context_limit_tokens: 100_000 },
    });
    // Strip ANSI.
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(Array.from(stripped).length).toBeLessThanOrEqual(30);
    // ctx widget should have been dropped.
    expect(line).not.toContain("ctx:");
  });

  test("output stays within budget when ctx widget is present", async () => {
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 , lifetimeCalls: 10 });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({
        home, tipSeed: i, env: envWith(),
        statusLineInput: { context_used_tokens: 80_000, context_limit_tokens: 100_000 },
      });
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(Array.from(stripped).length).toBeLessThanOrEqual(80);
    }
  });

  test("ctx width stable across 60 frames", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 , lifetimeCalls: 10 });
    const widths = new Set<number>();
    for (let f = 0; f < 60; f++) {
      const line = buildStatusLine({
        home, tipSeed: 0,
        env: envWith({ COLUMNS: "120" }),
        now: Date.now() + f * 120,
        statusLineInput: { context_used_tokens: 72_000, context_limit_tokens: 100_000 },
      });
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      widths.add(Array.from(stripped).length);
    }
    expect(widths.size).toBe(1);
  });

  // -------------------------------------------------------------------------

  test("activity indicator: present when active, absent when idle", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // lastSavingAt set to a fixed past timestamp — we control msSinceActive via `now`.
    const savingEpoch = 1_000_000; // ms since Unix epoch — a fixed small value
    const lastSavingAt = new Date(savingEpoch).toISOString();
    const stats = {
      schemaVersion: 2,
      sessions: {
        [SID]: {
          startedAt: new Date().toISOString(),
          lastSavingAt,
          calls: 3,
          tokensSaved: 5000,
          byTool: {},
        },
      },
      lifetime: { calls: 10, tokensSaved: 5000, byTool: {}, byDay: { [today]: { calls: 10, tokensSaved: 5000 } } },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));

    // Active: pass now = savingEpoch + 500ms (well within 4s window).
    // BASE_ENV has no LANG/TERM so unicode=false → ASCII "+" indicator.
    const activeLine = buildStatusLine({ home, tipSeed: 0, env: envWith(), now: savingEpoch + 500 });
    const activePlain = activeLine.replace(/\x1b\[[0-9;]*m/g, "");
    // Active: indicator glyph (↑ or + ASCII) before "+N".
    expect(activePlain).toMatch(/session [↑+]\+[\d.KM]+/);

    // Idle: pass now = savingEpoch + 10_000ms (10s after save → msSinceActive=10000 > 4000).
    const idleLine = buildStatusLine({ home, tipSeed: 0, env: envWith(), now: savingEpoch + 10_000 });
    const idlePlain = idleLine.replace(/\x1b\[[0-9;]*m/g, "");
    // Idle: "session +5.0K" — space directly before "+".
    expect(idlePlain).toMatch(/session \+[\d.KM]+/);
    // Ensure no indicator glyph before "+".
    expect(idlePlain).not.toMatch(/session [↑]\+/);
  });

  test("activity indicator width stable: 60 active frames all same visible width", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const savingEpoch = 1_000_000;
    const stats = {
      schemaVersion: 2,
      sessions: {
        [SID]: {
          startedAt: new Date().toISOString(),
          lastSavingAt: new Date(savingEpoch).toISOString(),
          calls: 3,
          tokensSaved: 5000,
          byTool: {},
        },
      },
      lifetime: { calls: 10, tokensSaved: 5000, byTool: {}, byDay: { [today]: { calls: 10, tokensSaved: 5000 } } },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));

    // 60 frames at 50ms intervals, all inside the 4s active window.
    const widths = new Set<number>();
    for (let f = 0; f < 60; f++) {
      const line = buildStatusLine({
        home, tipSeed: 0, env: envWith(), now: savingEpoch + f * 50,
      });
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      widths.add(Array.from(stripped).length);
    }
    // Width must be stable — indicator is always exactly 1 char wide.
    expect(widths.size).toBe(1);
  });

  test("activity pulse: recent lastSavingAt makes line include no ANSI when animation off (no regressions)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const stats = {
      schemaVersion: 2,
      sessions: {
        [SID]: {
          startedAt: new Date().toISOString(),
          lastSavingAt: new Date().toISOString(),
          calls: 5,
          tokensSaved: 1234,
          byTool: {},
        },
      },
      lifetime: { calls: 5, tokensSaved: 1234, byTool: {}, byDay: { [today]: { calls: 5, tokensSaved: 1234 } } },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    // ANSI escape CSI sequence should not appear when animation is disabled.
    expect(line).not.toMatch(/\x1b\[/);
  });

  // -------------------------------------------------------------------------
  // $ cost suffix on session segment
  // -------------------------------------------------------------------------

  test("cost suffix renders ≈$X.XX on session segment when session > 0", async () => {
    // 12.345K tokens at $3/MTok → ~$0.037 → "≈$0.04" (rounded up in formatCost)
    await writeStats({ sessionTokensSaved: 12_345, lifetimeTokensSaved: 20_000, lifetimeCalls: 10 });
    const line = buildStatusLine({
      home, tipSeed: 0, env: envWith({ COLUMNS: "120" }),
      suppressMilestoneSideEffects: true,
    });
    expect(line).toMatch(/session [↑+]?\+12\.3K ≈\$0\.\d{2}/);
  });

  test("cost suffix is ≈$0.00 when session tokens are 0", async () => {
    // Write a stats file with enough calls so we're past collecting… state.
    await writeStats({ sessionTokensSaved: 0, sessionCalls: 0, lifetimeCalls: 10, lifetimeTokensSaved: 500 });
    const line = buildStatusLine({
      home, tipSeed: 0, env: envWith({ COLUMNS: "120" }),
      suppressMilestoneSideEffects: true,
    });
    expect(line).toContain("≈$0.00");
  });

  test("cost grows with token volume", async () => {
    // 1M tokens → $3.00 exactly
    await writeStats({ sessionTokensSaved: 1_000_000, lifetimeTokensSaved: 1_000_000, lifetimeCalls: 10 });
    const line = buildStatusLine({
      home, tipSeed: 0, env: envWith({ COLUMNS: "120" }),
      suppressMilestoneSideEffects: true,
    });
    expect(line).toContain("≈$3.00");
  });

  // -------------------------------------------------------------------------
  // 10k lifetime milestone celebration
  // -------------------------------------------------------------------------

  test("milestone 10k: fires once, writes milestones.json, prints to stderr", async () => {
    await writeStats({ sessionTokensSaved: 0, lifetimeTokensSaved: 12_000 , lifetimeCalls: 10 });

    // Capture stderr for the single call we care about.
    const stderrOrig = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    // @ts-ignore — patch for test
    process.stderr.write = (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    };
    try {
      // Explicitly clear ASHLR_DISABLE_MILESTONES so the celebration fires.
      const env: NodeJS.ProcessEnv = { ...BASE_ENV };
      delete env.ASHLR_DISABLE_MILESTONES;
      buildStatusLine({ home, tipSeed: 0, env });
    } finally {
      // @ts-ignore
      process.stderr.write = stderrOrig;
    }

    const stderrOut = chunks.join("");
    expect(stderrOut).toContain("10,000 tokens saved");

    // milestones.json should now carry the flag.
    const { readFileSync } = await import("fs");
    const raw = readFileSync(join(home, ".ashlr", "milestones.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.ten_k_reached).toBe(true);
  });

  test("milestone 10k: does not fire twice (flag persisted)", async () => {
    await writeStats({ sessionTokensSaved: 0, lifetimeTokensSaved: 20_000 , lifetimeCalls: 10 });
    // Pre-set the flag — subsequent renders must stay silent.
    const { mkdirSync: mk, writeFileSync: wf } = await import("fs");
    mk(join(home, ".ashlr"), { recursive: true });
    wf(join(home, ".ashlr", "milestones.json"), JSON.stringify({ ten_k_reached: true }));

    const stderrOrig = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    // @ts-ignore
    process.stderr.write = (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    };
    try {
      const env: NodeJS.ProcessEnv = { ...BASE_ENV };
      delete env.ASHLR_DISABLE_MILESTONES;
      buildStatusLine({ home, tipSeed: 0, env });
    } finally {
      // @ts-ignore
      process.stderr.write = stderrOrig;
    }
    expect(chunks.join("")).not.toContain("10,000 tokens saved");
  });

  test("milestone 10k: suppressed by ASHLR_DISABLE_MILESTONES env var", async () => {
    await writeStats({ sessionTokensSaved: 0, lifetimeTokensSaved: 50_000 , lifetimeCalls: 10 });
    const stderrOrig = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    // @ts-ignore
    process.stderr.write = (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    };
    try {
      // BASE_ENV already sets ASHLR_DISABLE_MILESTONES=1.
      buildStatusLine({ home, tipSeed: 0, env: envWith() });
    } finally {
      // @ts-ignore
      process.stderr.write = stderrOrig;
    }
    expect(chunks.join("")).not.toContain("10,000 tokens saved");
  });

  test("milestone 10k: does not fire when lifetime is below threshold", async () => {
    await writeStats({ sessionTokensSaved: 0, lifetimeTokensSaved: 9_999 , lifetimeCalls: 10 });
    const stderrOrig = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    // @ts-ignore
    process.stderr.write = (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    };
    try {
      const env: NodeJS.ProcessEnv = { ...BASE_ENV };
      delete env.ASHLR_DISABLE_MILESTONES;
      buildStatusLine({ home, tipSeed: 0, env });
    } finally {
      // @ts-ignore
      process.stderr.write = stderrOrig;
    }
    expect(chunks.join("")).not.toContain("10,000 tokens saved");
  });

  // -------------------------------------------------------------------------
  // v1.20.2: session-hint fallback
  //
  // Regression: when CLAUDE_SESSION_ID isn't forwarded to the status-line
  // (Claude Code doesn't forward it to MCP-spawned processes, but in some
  // builds it isn't forwarded to the status-line either), the local
  // candidateSessionIds() must fall back to ~/.ashlr/last-project.json's
  // sessionId — the same file MCP writers consult — so writers and reader
  // converge on the same bucket. v1.20.1 fixed this for _stats.ts but the
  // status-line had its own copy of candidateSessionIds that was missed.
  // -------------------------------------------------------------------------

  test("session-hint fallback: status-line reads bucket written under hint id when CLAUDE_SESSION_ID is unset", async () => {
    // Hint file says the writer used "h-hint-id" as the session id.
    const hintId = "h-hint-id";
    await writeFile(
      join(home, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp/fake-project",
        updatedAt: new Date().toISOString(),
        sessionId: hintId,
      }),
    );

    // Stats file has a non-zero bucket under the hint id (this is what the
    // MCP writer would produce after it consults the hint).
    const payload = {
      schemaVersion: 2,
      sessions: {
        [hintId]: {
          startedAt: new Date().toISOString(),
          lastSavingAt: null,
          calls: 7,
          tokensSaved: 4_321,
          byTool: {},
        },
      },
      lifetime: { calls: 7, tokensSaved: 4_321, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(payload));

    // Critical: env has NO CLAUDE_SESSION_ID and NO ASHLR_SESSION_ID, plus
    // HOME pointed at our temp dir so readSessionHint reads the right file.
    const env: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      ASHLR_STATUS_ANIMATE: "0",
      COLUMNS: "80",
      ASHLR_DISABLE_MILESTONES: "1",
      HOME: home,
    };
    const line = buildStatusLine({ home, tipSeed: 0, env });
    // Without the fix this would render "session +0".
    expect(line).toContain("session +4.3K");
  });

  test("session-hint fallback: explicit CLAUDE_SESSION_ID still wins over hint", async () => {
    // Both ids point at non-zero buckets — explicit must take precedence so
    // we know the env override path still works.
    const hintId = "h-hint-id";
    const explicit = "explicit-sid";
    await writeFile(
      join(home, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp/fake-project",
        updatedAt: new Date().toISOString(),
        sessionId: hintId,
      }),
    );
    const payload = {
      schemaVersion: 2,
      sessions: {
        [hintId]: { startedAt: new Date().toISOString(), lastSavingAt: null, calls: 1, tokensSaved: 1_111, byTool: {} },
        [explicit]: { startedAt: new Date().toISOString(), lastSavingAt: null, calls: 1, tokensSaved: 9_999, byTool: {} },
      },
      lifetime: { calls: 2, tokensSaved: 11_110, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(payload));

    // Both env and hint resolve — the reader should sum across BOTH buckets,
    // matching the writer that may have landed savings in either spot.
    const env: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      ASHLR_STATUS_ANIMATE: "0",
      COLUMNS: "80",
      ASHLR_DISABLE_MILESTONES: "1",
      HOME: home,
      CLAUDE_SESSION_ID: explicit,
    };
    const line = buildStatusLine({ home, tipSeed: 0, env });
    // Sum of 9_999 + 1_111 = 11_110 → formatted as "11.1K"
    expect(line).toContain("session +11.1K");
  });

  test("session-hint fallback: stale hint (>24h old) is ignored", async () => {
    // Hint has updatedAt 25 hours ago — must be rejected as TTL-expired.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(
      join(home, ".ashlr", "last-project.json"),
      JSON.stringify({ projectDir: "/tmp/x", updatedAt: stale, sessionId: "h-stale" }),
    );
    const payload = {
      schemaVersion: 2,
      sessions: {
        "h-stale": { startedAt: stale, lastSavingAt: null, calls: 1, tokensSaved: 5_000, byTool: {} },
      },
      lifetime: { calls: 1, tokensSaved: 5_000, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(payload));
    const env: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      ASHLR_STATUS_ANIMATE: "0",
      COLUMNS: "80",
      ASHLR_DISABLE_MILESTONES: "1",
      HOME: home,
    };
    const line = buildStatusLine({ home, tipSeed: 0, env });
    // The stale hint must NOT route to its bucket. ppid-hash bucket has no
    // entry → session shows +0.
    expect(line).toContain("session +0");
  });
});


// ---------------------------------------------------------------------------
// Zero-savings credibility: 3-state status rendering (v1.21)
// ---------------------------------------------------------------------------

describe("zero-savings credibility states", () => {
  test("state 1: no stats file → (waiting for first tool call) message", () => {
    // No ~/.ashlr/stats.json exists: first-use state.
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("waiting for first tool call");
    expect(plain).not.toContain("session +0");
    expect(plain).not.toContain("lifetime");
  });

  test("state 2: stats file present, lifetimeCalls < 5 → session +0 (collecting…)", async () => {
    // File exists but < 5 lifetime calls: collecting state.
    await writeStats({ sessionTokensSaved: 0, sessionCalls: 2, lifetimeCalls: 3, lifetimeTokensSaved: 0 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("session +0 (collecting…)");
    expect(plain).not.toContain("waiting for first tool call");
    // lifetime segment suppressed in collecting state
    expect(plain).not.toContain("lifetime");
  });

  test("state 3: stats present, lifetimeCalls >= 5, session 0 → normal session +0", async () => {
    // Established user, current session hasn't saved yet.
    await writeStats({ sessionTokensSaved: 0, sessionCalls: 0, lifetimeCalls: 10, lifetimeTokensSaved: 1500 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("session +0");
    expect(plain).not.toContain("collecting…");
    expect(plain).not.toContain("waiting for first tool call");
    // lifetime is shown normally when >= 5 calls
    expect(plain).toContain("lifetime +1.5K");
  });

  test("state 2 exact boundary: lifetimeCalls=4 → collecting, lifetimeCalls=5 → normal", async () => {
    await writeStats({ sessionTokensSaved: 0, sessionCalls: 0, lifetimeCalls: 4, lifetimeTokensSaved: 0 });
    const lineAt4 = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(lineAt4.replace(/\x1b\[[0-9;]*m/g, "")).toContain("collecting…");

    await writeStats({ sessionTokensSaved: 0, sessionCalls: 0, lifetimeCalls: 5, lifetimeTokensSaved: 0 });
    // Reset read cache so fresh stats are picked up.
    const { _resetReadCache } = await import("../scripts/savings-status-line");
    _resetReadCache();
    const lineAt5 = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    const plainAt5 = lineAt5.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainAt5).not.toContain("collecting…");
    expect(plainAt5).toContain("session +0");
  });
});
