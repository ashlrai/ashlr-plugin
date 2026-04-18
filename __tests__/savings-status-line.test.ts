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
const BASE_ENV = Object.freeze({
  NO_COLOR: "1",
  ASHLR_STATUS_ANIMATE: "0",
  CLAUDE_SESSION_ID: SID,
  COLUMNS: "80",
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
  test("no stats file, no settings → brand-only line (defaults)", () => {
    // Defaults: everything on, but counters are zero.
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line.startsWith("ashlr")).toBe(true);
    expect(line).toContain("session +0");
    expect(line).toContain("lifetime +0");
    expect(line.length).toBeLessThanOrEqual(80);
  });

  test("stats present → formatted with K/M units", async () => {
    await writeStats({ sessionTokensSaved: 12_345, sessionCalls: 4, lifetimeTokensSaved: 1_240_000, lifetimeCalls: 100 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line).toContain("session +12.3K");
    expect(line).toContain("lifetime +1.2M");
  });

  test("statusLine: false → empty string", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 1000 });
    await writeSettings({ statusLine: false });
    expect(buildStatusLine({ home, env: envWith() })).toBe("");
  });

  test("statusLineSession: false → lifetime only", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 5000 });
    await writeSettings({ statusLineSession: false, statusLineTips: false });
    const line = buildStatusLine({ home, env: envWith() });
    expect(line).not.toContain("session");
    expect(line).toContain("lifetime +5.0K");
  });

  test("statusLineLifetime: false → session only", async () => {
    await writeStats({ sessionTokensSaved: 2000, lifetimeTokensSaved: 5000 });
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
    await writeStats({ sessionTokensSaved: 10, lifetimeTokensSaved: 10 });
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
    await writeStats({ sessionTokensSaved: 7, lifetimeTokensSaved: 9 });
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
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({ home, tipSeed: i, env: envWith() });
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("wide terminal ($COLUMNS=120) → full tip renders", async () => {
    await writeStats({ sessionTokensSaved: 999_999, lifetimeTokensSaved: 999_999 });
    // tipSeed: 6 targets "savings persist in ~/.ashlr/stats.json"
    const line = buildStatusLine({ home, tipSeed: 6, env: envWith({ COLUMNS: "120" }) });
    expect(line).toContain("tip: savings persist in ~/.ashlr/stats.json");
    expect(line.length).toBeLessThanOrEqual(120);
  });

  test("80-col terminal with long numbers → tip dropped cleanly, no mid-word truncation", async () => {
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({ home, tipSeed: i, env: envWith() });
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/tip: [^·]*…/);
    }
  });

  test("default $COLUMNS unset → falls back to 80 budget", async () => {
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 });
    const line = buildStatusLine({ home, tipSeed: 0, env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: SID } });
    expect(line.length).toBeLessThanOrEqual(80);
  });

  // -------------------------------------------------------------------------
  // Context-pressure widget
  // -------------------------------------------------------------------------

  test("ctx widget renders when statusLineInput carries context_used/limit tokens", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: envWith({ COLUMNS: "120" }),
      statusLineInput: { context_used_tokens: 50_000, context_limit_tokens: 100_000 },
    });
    expect(line).toContain("ctx: 50%");
  });

  test("ctx widget hidden when no statusLineInput", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith() });
    expect(line).not.toContain("ctx:");
  });

  test("ctx widget hidden when statusLineInput is null", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
    const line = buildStatusLine({ home, tipSeed: 0, env: envWith(), statusLineInput: null });
    expect(line).not.toContain("ctx:");
  });

  test("ctx widget hidden when statusLineInput has no usable fields", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
    const line = buildStatusLine({
      home, tipSeed: 0, env: envWith(),
      statusLineInput: { input_tokens: 5000 }, // no limit field → cannot compute pct
    });
    expect(line).not.toContain("ctx:");
  });

  test("ctx widget appears between sparkline+brand and session segment", async () => {
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
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
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
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
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
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
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
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
    await writeStats({ sessionTokensSaved: 999_999_999, lifetimeTokensSaved: 999_999_999 });
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
    await writeStats({ sessionTokensSaved: 1000, lifetimeTokensSaved: 2000 });
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
      lifetime: { calls: 3, tokensSaved: 5000, byTool: {}, byDay: { [today]: { calls: 3, tokensSaved: 5000 } } },
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
      lifetime: { calls: 3, tokensSaved: 5000, byTool: {}, byDay: { [today]: { calls: 3, tokensSaved: 5000 } } },
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
});
