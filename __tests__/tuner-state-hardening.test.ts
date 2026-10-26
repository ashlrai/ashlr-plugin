/**
 * Tuning state files are untrusted input: corrupt, null, wrong-type, huge and
 * hostile files must fall back to defaults (level 0) and never break a tool.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  isoWeek, MAX_EXT_KEYS, MAX_WEEKS, missStatsPath, observeToolCall, OTHER_EXT,
  readRepoMissFile, sanitizeRepoMissFile,
} from "../servers/_miss-tracker";
import { readTuning, sanitizeTuning, tunedDetail, tuneRepo, tuningPath } from "../servers/_tuner";
import { renderTuningSection } from "../servers/_tuning-render";
import { ashlrGrep } from "../servers/grep-server";

const CWD = "/repo";
let home: string;
const ENV = { home: process.env.ASHLR_HOME_OVERRIDE, tuning: process.env.ASHLR_TUNING, log: process.env.ASHLR_SESSION_LOG };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-tune-hard-"));
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
});
afterEach(() => {
  for (const [k, v] of [["ASHLR_HOME_OVERRIDE", ENV.home], ["ASHLR_TUNING", ENV.tuning], ["ASHLR_SESSION_LOG", ENV.log]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeRaw(p: string, body: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

const HOSTILE: Record<string, string> = {
  null: "null",
  number: "42",
  string: '"x"',
  array: "[1,2,3]",
  invalidJson: "{not json",
  toolNull: '{"ashlr__grep":null,"ashlr__read":null}',
  extNull: '{"ashlr__grep":{"(none)":null}}',
  levelString: '{"ashlr__grep":{"(none)":{"level":"9e9","atSample":1}}}',
  levelNaN: '{"ashlr__grep":{"(none)":{"level":null,"atSample":"x"}}}',
  hugeAtSample: '{"ashlr__grep":{"(none)":{"level":1e308,"atSample":1e308}}}',
  proto: '{"__proto__":{"level":2},"constructor":{"(none)":{"level":2}}}',
};

describe("tuning state hardening", () => {
  for (const [name, body] of Object.entries(HOSTILE)) {
    test(`tuning file ${name}: tunedDetail stays bounded and never throws`, () => {
      writeRaw(tuningPath(home, CWD), body);
      const lvl = tunedDetail("ashlr__grep", "(none)", home, CWD);
      expect(lvl).toBe(0);
      expect(() => readTuning(home, CWD)).not.toThrow();
    });
    test(`miss-stats file ${name}: reads as defaults, tuneRepo and render never throw`, () => {
      writeRaw(missStatsPath(home, CWD), body);
      const f = readRepoMissFile(home, CWD);
      expect(typeof f.tools).toBe("object");
      expect(typeof f.weeks).toBe("object");
      expect(() => tuneRepo(home, CWD)).not.toThrow();
      expect(() => renderTuningSection(home, CWD)).not.toThrow();
    });
  }

  test("non-numeric level is level 0, not coerced", () => {
    expect(sanitizeTuning(JSON.parse(HOSTILE.levelString!)).ashlr__grep!["(none)"]!.level).toBe(0);
  });

  test("unknown tools and odd extension keys are dropped or folded", () => {
    const t = sanitizeTuning({ evil: { ".ts": { level: 2 } }, ashlr__read: { "../../x": { level: 2, atSample: 1 } } });
    expect(t.evil).toBeUndefined();
    expect(Object.keys(t.ashlr__read!)).toEqual([OTHER_EXT]);
  });

  test("caps: extension keys and weeks are bounded", () => {
    const row: Record<string, { compressed: number; misses: number }> = {};
    for (let i = 0; i < 500; i++) row[`.e${i}`] = { compressed: i + 1, misses: 0 };
    const weeks: Record<string, unknown> = {};
    for (let i = 10; i < 60; i++) weeks[`2026-W${i}`] = { compressed: 1, misses: 0, refetchBytes: 0 };
    const f = sanitizeRepoMissFile({ tools: { ashlr__read: row }, weeks });
    expect(Object.keys(f.tools.ashlr__read!).length).toBe(MAX_EXT_KEYS);
    expect(f.tools.ashlr__read![".e499"]).toBeDefined(); // top by samples kept
    expect(f.tools.ashlr__read![OTHER_EXT]!.compressed).toBeGreaterThan(0);
    expect(Object.keys(f.weeks).length).toBe(MAX_WEEKS);
    expect(Object.keys(f.weeks).sort()[0]).toBe(`2026-W${60 - MAX_WEEKS}`);
  });

  test("caps hold on disk after many writes; files are 0600 in a 0700 dir", () => {
    for (let i = 0; i < MAX_EXT_KEYS + 20; i++) observeToolCall("ashlr__read", { path: `f.x${i}` }, i * 10, "s", home, CWD);
    const raw = JSON.parse(readFileSync(missStatsPath(home, CWD), "utf-8"));
    expect(Object.keys(raw.tools.ashlr__read).length).toBeLessThanOrEqual(MAX_EXT_KEYS);
    if (process.platform !== "win32") {
      expect(statSync(missStatsPath(home, CWD)).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(missStatsPath(home, CWD))).mode & 0o777).toBe(0o700);
    }
  });

  test("ASHLR_SESSION_LOG=0 is named as the reason in the report", () => {
    process.env.ASHLR_SESSION_LOG = "0";
    expect(renderTuningSection(home, CWD)).toBe("self-tuning: off (ASHLR_SESSION_LOG=0)");
  });

  test("week bucketing is UTC: Sunday 23:30 UTC and Monday 00:30 UTC fall in different weeks", () => {
    expect(isoWeek(Date.parse("2026-10-25T23:30:00Z"))).toBe("2026-W43");
    expect(isoWeek(Date.parse("2026-10-26T00:30:00Z"))).toBe("2026-W44");
  });
});

describe("grep still works with hostile tuning state", () => {
  let repo: string;
  let prev: string;
  beforeEach(() => {
    prev = process.cwd();
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ashlr-tune-grep-")));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "const matchMe = 42;\n");
    process.chdir(repo);
    process.env.ASHLR_HOME_OVERRIDE = home;
  });
  afterEach(() => { process.chdir(prev); rmSync(repo, { recursive: true, force: true }); });

  test("output with null/corrupt state equals output with no state", async () => {
    const baseline = await ashlrGrep({ pattern: "matchMe", cwd: repo });
    expect(baseline).toContain("matchMe");
    for (const body of ["null", "{not json", HOSTILE.toolNull!, HOSTILE.levelString!]) {
      writeRaw(tuningPath(home, repo), body);
      expect(await ashlrGrep({ pattern: "matchMe", cwd: repo })).toBe(baseline);
    }
  });
});
