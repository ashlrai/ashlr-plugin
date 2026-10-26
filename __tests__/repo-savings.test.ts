import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { isoWeek, MAX_WEEKS, missStatsPath } from "../servers/_miss-tracker";
import { readRepoSavings, recordRepoSaving, repoSavingsPath } from "../servers/_repo-savings";
import { renderTuningSection } from "../servers/_tuning-render";

const A = "/repo-a";
const B = "/repo-b";
const NOW = Date.parse("2026-10-25T12:00:00Z"); // 2026-W43 (UTC)
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-repo-sav-"));
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
});
afterEach(() => {
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
  rmSync(home, { recursive: true, force: true });
});

function writeRaw(p: string, body: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

describe("per-repo savings", () => {
  test("attribution: savings land in the repo they were recorded in, by UTC week", () => {
    recordRepoSaving(100, home, A, NOW);
    recordRepoSaving(50, home, A, NOW);
    recordRepoSaving(7, home, B, NOW);
    recordRepoSaving(9, home, A, Date.parse("2026-10-26T00:30:00Z")); // next UTC week
    expect(readRepoSavings(home, A).weeks).toEqual({ "2026-W43": 150, "2026-W44": 9 });
    expect(readRepoSavings(home, B).weeks).toEqual({ "2026-W43": 7 });
  });

  test("ignores zero, negative and non-finite amounts; 0600 file in 0700 dir; keeps MAX_WEEKS", () => {
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) recordRepoSaving(v, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({});
    for (let i = 0; i < MAX_WEEKS + 5; i++) recordRepoSaving(1, home, A, NOW - i * 7 * 86400000);
    expect(Object.keys(readRepoSavings(home, A).weeks).length).toBe(MAX_WEEKS);
    expect(Object.keys(JSON.parse(readFileSync(repoSavingsPath(home, A), "utf-8")).weeks).length).toBe(MAX_WEEKS);
    if (process.platform !== "win32") {
      expect(statSync(repoSavingsPath(home, A)).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(repoSavingsPath(home, A))).mode & 0o777).toBe(0o700);
    }
  });

  for (const body of ["null", "42", "[1]", "{bad", '{"weeks":null}', '{"weeks":{"2026-W43":"9e9","evil":5,"2026-W42":-3}}', '{"weeks":{"2026-W43":1e308}}']) {
    test(`hostile state ${body}: reads fail-safe, record and render never throw`, () => {
      writeRaw(repoSavingsPath(home, A), body);
      const w = readRepoSavings(home, A).weeks;
      for (const [k, v] of Object.entries(w)) {
        expect(k).toMatch(/^\d{4}-W\d{2}$/);
        expect(Number.isFinite(v) && v >= 0).toBe(true);
      }
      expect(() => recordRepoSaving(5, home, A, NOW)).not.toThrow();
      expect(() => renderTuningSection(home, A, NOW)).not.toThrow();
    });
  }

  test("off switch: ASHLR_TUNING=off records nothing and the report says off", () => {
    process.env.ASHLR_TUNING = "off";
    recordRepoSaving(100, home, A, NOW);
    expect(readRepoSavings(home, A).weeks).toEqual({});
    expect(renderTuningSection(home, A, NOW)).toBe("self-tuning: off (ASHLR_TUNING=off)");
  });

  test("net math: this repo's saved minus re-read bytes/4, other repos excluded", () => {
    recordRepoSaving(1000, home, A, NOW);
    recordRepoSaving(99999, home, B, NOW); // must not appear in repo A's net
    writeRaw(missStatsPath(home, A), JSON.stringify({ tools: {}, weeks: { [isoWeek(NOW)]: { compressed: 10, misses: 1, refetchBytes: 400 } } }));
    const out = renderTuningSection(home, A, NOW)!;
    const row = out.split("\n").find((l) => l.includes("2026-W43"))!;
    expect(row).toMatch(/1,000\s+100\s+900\s+10\.0% \(1\/10\)/);
    expect(out).not.toContain("99,999");
  });

  test("snapshot (synthetic fixture, not real usage)", () => {
    writeRaw(repoSavingsPath(home, A), JSON.stringify({ weeks: { "2026-W42": 12000, "2026-W43": 3500 } }));
    writeRaw(missStatsPath(home, A), JSON.stringify({
      tools: {},
      weeks: { "2026-W42": { compressed: 50, misses: 5, refetchBytes: 4000 }, "2026-W43": { compressed: 40, misses: 2, refetchBytes: 800 } },
    }));
    expect(renderTuningSection(home, A, NOW)).toMatchSnapshot();
  });
});
