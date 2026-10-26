import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { missStatsPath } from "../servers/_miss-tracker";
import {
  HIGH_MISS_RATE, LOW_MISS_RATE, MAX_DETAIL, MIN_DETAIL, MIN_SAMPLES,
  nextPairState, tunedDetail, tuneRepo,
} from "../servers/_tuner";
import { renderTuningSection } from "../servers/_tuning-render";

const CWD = "/repo";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-tuner-"));
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
});
afterEach(() => {
  delete process.env.ASHLR_TUNING;
  rmSync(home, { recursive: true, force: true });
});

function writeStats(file: unknown) {
  const p = missStatsPath(home, CWD);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file));
}

describe("tuner", () => {
  test("min-sample gating: no change below MIN_SAMPLES", () => {
    const s = nextPairState(undefined, { compressed: MIN_SAMPLES - 1, misses: MIN_SAMPLES - 1 });
    expect(s.level).toBe(0);
  });

  test("high miss rate raises detail by one step; low rate compresses harder", () => {
    const n = MIN_SAMPLES;
    expect(nextPairState(undefined, { compressed: n, misses: Math.ceil(n * HIGH_MISS_RATE) }).level).toBe(1);
    expect(nextPairState(undefined, { compressed: n, misses: Math.floor(n * LOW_MISS_RATE) }).level).toBe(-1);
    expect(nextPairState(undefined, { compressed: n, misses: Math.round(n * 0.15) }).level).toBe(0);
  });

  test("one step per MIN_SAMPLES new results, never beyond bounds", () => {
    let s = nextPairState(undefined, { compressed: MIN_SAMPLES, misses: MIN_SAMPLES });
    expect(nextPairState(s, { compressed: MIN_SAMPLES + 5, misses: MIN_SAMPLES + 5 }).level).toBe(1);
    for (let i = 2; i < 10; i++) s = nextPairState(s, { compressed: MIN_SAMPLES * i, misses: MIN_SAMPLES * i });
    expect(s.level).toBe(MAX_DETAIL);
    for (let i = 10; i < 20; i++) s = nextPairState(s, { compressed: MIN_SAMPLES * i, misses: 0 });
    expect(s.level).toBe(MIN_DETAIL);
    expect(nextPairState({ level: 99, atSample: 0 }, { compressed: 1, misses: 0 }).level).toBe(MAX_DETAIL);
  });

  test("tuneRepo persists per repo and tunedDetail reads it", () => {
    writeStats({ tools: { ashlr__read: { ".ts": { compressed: 40, misses: 20 } } }, weeks: {} });
    tuneRepo(home, CWD);
    expect(tunedDetail("ashlr__read", ".TS", home, CWD)).toBe(1);
    expect(tunedDetail("ashlr__read", ".ts", home, "/other-repo")).toBe(0);
  });

  test("ASHLR_TUNING=off: level 0 and no updates", () => {
    writeStats({ tools: { ashlr__read: { ".ts": { compressed: 40, misses: 20 } } }, weeks: {} });
    tuneRepo(home, CWD);
    process.env.ASHLR_TUNING = "off";
    expect(tunedDetail("ashlr__read", ".ts", home, CWD)).toBe(0);
    expect(tuneRepo(home, CWD)).toEqual({});
    expect(renderTuningSection({}, home, CWD)).toBe("self-tuning: off (ASHLR_TUNING=off)");
  });
});

describe("savings render: self-tuning section", () => {
  test("snapshot: net tokens (est.) and miss rate by week", () => {
    const now = Date.parse("2026-10-25T12:00:00Z"); // ISO week 2026-W43
    writeStats({
      tools: {},
      weeks: {
        "2026-W42": { compressed: 50, misses: 5, refetchBytes: 4000 },
        "2026-W43": { compressed: 40, misses: 2, refetchBytes: 800 },
      },
    });
    const byDay = { "2026-10-14": { tokensSaved: 12000 }, "2026-10-20": { tokensSaved: 3000 }, "2026-10-25": { tokensSaved: 500 } };
    expect(renderTuningSection(byDay, home, CWD, now)).toMatchSnapshot();
  });

  test("no section without miss data", () => {
    expect(renderTuningSection({}, home, CWD)).toBeNull();
  });
});
