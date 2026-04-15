/**
 * Unit tests for the ashlr status-line composer.
 *
 * We exercise buildStatusLine() with a synthetic HOME so each case gets an
 * isolated filesystem.  No real ~/.ashlr or ~/.claude is read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildStatusLine, formatTokens, renderSparkline } from "../scripts/savings-status-line";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-statusline-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeStats(stats: unknown): Promise<void> {
  await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
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

describe("buildStatusLine", () => {
  test("no stats file, no settings → brand-only line (defaults)", () => {
    // Defaults: everything on, but counters are zero.
    const line = buildStatusLine({ home, tipSeed: 0 });
    expect(line.startsWith("ashlr")).toBe(true);
    expect(line).toContain("session +0");
    expect(line).toContain("lifetime +0");
    expect(line.length).toBeLessThanOrEqual(80);
  });

  test("stats present → formatted with K/M units", async () => {
    await writeStats({
      session: { calls: 4, tokensSaved: 12_345 },
      lifetime: { calls: 100, tokensSaved: 1_240_000 },
    });
    const line = buildStatusLine({ home, tipSeed: 0 });
    expect(line).toContain("session +12.3K");
    expect(line).toContain("lifetime +1.2M");
  });

  test("statusLine: false → empty string", async () => {
    await writeStats({ session: { tokensSaved: 1000 }, lifetime: { tokensSaved: 1000 } });
    await writeSettings({ statusLine: false });
    expect(buildStatusLine({ home })).toBe("");
  });

  test("statusLineSession: false → lifetime only", async () => {
    await writeStats({
      session: { tokensSaved: 1000 },
      lifetime: { tokensSaved: 5000 },
    });
    await writeSettings({ statusLineSession: false, statusLineTips: false });
    const line = buildStatusLine({ home });
    expect(line).not.toContain("session");
    expect(line).toContain("lifetime +5.0K");
  });

  test("statusLineLifetime: false → session only", async () => {
    await writeStats({
      session: { tokensSaved: 2000 },
      lifetime: { tokensSaved: 5000 },
    });
    await writeSettings({ statusLineLifetime: false, statusLineTips: false });
    const line = buildStatusLine({ home });
    expect(line).toContain("session +2.0K");
    expect(line).not.toContain("lifetime");
  });

  test("tips disabled → no 'tip:' segment", async () => {
    await writeSettings({ statusLineTips: false });
    const line = buildStatusLine({ home });
    expect(line).not.toContain("tip:");
  });

  test("tips enabled → tip segment appears (when it fits)", async () => {
    await writeStats({ session: { tokensSaved: 10 }, lifetime: { tokensSaved: 10 } });
    // Use a generous budget so the tip reliably fits regardless of which tip
    // the seed lands on.
    const line = buildStatusLine({ home, tipSeed: 0, env: { COLUMNS: "120" } });
    expect(line).toContain("tip:");
  });

  test("corrupt stats.json → graceful fallback, no exception", async () => {
    await writeFile(join(home, ".ashlr", "stats.json"), "{not json");
    const line = buildStatusLine({ home, tipSeed: 0 });
    expect(line.startsWith("ashlr")).toBe(true);
    expect(line).toContain("session +0");
  });

  test("corrupt settings.json → graceful fallback to defaults", async () => {
    await writeFile(join(home, ".claude", "settings.json"), "{broken");
    await writeStats({ session: { tokensSaved: 7 }, lifetime: { tokensSaved: 9 } });
    const line = buildStatusLine({ home, tipSeed: 0 });
    expect(line).toContain("session +7");
    expect(line).toContain("lifetime +9");
  });

  test("sparkline: default on, rendered with Braille chars between brand and session", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await writeStats({
      session: { tokensSaved: 12_300 },
      lifetime: {
        tokensSaved: 1_240_000,
        byDay: { [today]: { calls: 5, tokensSaved: 50_000 } },
      },
    });
    const line = buildStatusLine({ home, tipSeed: 0 });
    // Brand, space, then 7 Braille chars (one per day), then ' · session …'
    expect(line).toMatch(/^ashlr [\u2800-\u28FF]{7} · session/);
    expect(line.length).toBeLessThanOrEqual(80);
  });

  test("sparkline: statusLineSparkline:false removes the Braille segment", async () => {
    await writeStats({
      session: { tokensSaved: 12_300 },
      lifetime: {
        tokensSaved: 1_240_000,
        byDay: { "2020-01-01": { calls: 5, tokensSaved: 50_000 } },
      },
    });
    await writeSettings({ statusLineSparkline: false });
    const line = buildStatusLine({ home, tipSeed: 0 });
    expect(line.startsWith("ashlr · ")).toBe(true);
    // No Braille glyphs present.
    expect(/[\u2800-\u28FF]/.test(line)).toBe(false);
  });

  test("sparkline: chars scale relative to busiest day in the 7-day window", () => {
    const now = new Date();
    const day = (offset: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    // Today = max (100%), day-1 = 50%, rest empty.
    const byDay = {
      [day(0)]: { tokensSaved: 1000 },
      [day(1)]: { tokensSaved: 500 },
    };
    const spark = renderSparkline(byDay, 7);
    expect(spark.length).toBe(7);
    // All chars are Braille.
    for (const ch of spark) expect(ch.codePointAt(0)! >= 0x2800 && ch.codePointAt(0)! <= 0x28FF).toBe(true);
    // Today (index 6, last in window) is the fullest char: ⣿
    expect(spark[6]).toBe("\u28FF");
    // Index 5 is day(1) — a mid-rung char, strictly between blank and full.
    expect(spark[5]).not.toBe("\u2800");
    expect(spark[5]).not.toBe("\u28FF");
    // Index 0 (day(6), no data) is blank.
    expect(spark[0]).toBe("\u2800");
  });

  test("sparkline: empty byDay yields all-blank 7-char string", () => {
    expect(renderSparkline(undefined, 7)).toBe("\u2800".repeat(7));
    expect(renderSparkline({}, 7)).toBe("\u2800".repeat(7));
  });

  test("output stays within 80 chars", async () => {
    await writeStats({
      session: { tokensSaved: 999_999_999 },
      lifetime: { tokensSaved: 999_999_999 },
    });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({ home, tipSeed: i });
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("wide terminal ($COLUMNS=120) → full tip renders", async () => {
    await writeStats({
      session: { tokensSaved: 999_999 },
      lifetime: { tokensSaved: 999_999 },
    });
    // tipSeed: 6 targets "savings persist in ~/.ashlr/stats.json"
    const line = buildStatusLine({ home, tipSeed: 6, env: { COLUMNS: "120" } });
    expect(line).toContain("tip: savings persist in ~/.ashlr/stats.json");
    expect(line.length).toBeLessThanOrEqual(120);
  });

  test("80-col terminal with long numbers → tip dropped cleanly, no mid-word truncation", async () => {
    // Build worst-case: 9-digit numbers + a long tip seed.
    await writeStats({
      session: { tokensSaved: 999_999_999 },
      lifetime: { tokensSaved: 999_999_999 },
    });
    for (let i = 0; i < 7; i++) {
      const line = buildStatusLine({ home, tipSeed: i, env: { COLUMNS: "80" } });
      expect(line.length).toBeLessThanOrEqual(80);
      // Never show a mid-word truncated tip ("tip: foo…").
      expect(line).not.toMatch(/tip: [^·]*…/);
    }
  });

  test("default $COLUMNS unset → falls back to 80 budget", async () => {
    await writeStats({
      session: { tokensSaved: 999_999_999 },
      lifetime: { tokensSaved: 999_999_999 },
    });
    const line = buildStatusLine({ home, tipSeed: 0, env: {} });
    expect(line.length).toBeLessThanOrEqual(80);
  });
});
