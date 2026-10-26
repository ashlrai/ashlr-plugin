import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { DEFAULT_THRESHOLD_BYTES } from "../servers/_summarize";
import { DETAIL_FACTOR, MAX_DETAIL, tunedThreshold, tuningPath } from "../servers/_tuner";

const CWD = "/repo";
let home: string;

function setLevel(ext: string, level: number) {
  const p = tuningPath(home, CWD);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ashlr__read: { [ext]: { level, atSample: 40 } } }));
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ashlr-read-wiring-")); delete process.env.ASHLR_TUNING; });
afterEach(() => { delete process.env.ASHLR_TUNING; rmSync(home, { recursive: true, force: true }); });

describe("tuner wiring: ashlr__read summarize threshold", () => {
  test("level 0 (no state, or stored 0) passes no threshold, so read output is unchanged", () => {
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, CWD)).toBeUndefined();
    setLevel(".ts", 0);
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, CWD)).toBeUndefined();
  });

  test("+level raises the threshold (more raw detail), -level lowers it", () => {
    setLevel(".ts", 1);
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, CWD)).toBe(Math.round(DEFAULT_THRESHOLD_BYTES * DETAIL_FACTOR));
    setLevel(".ts", -1);
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, CWD)!).toBeLessThan(DEFAULT_THRESHOLD_BYTES);
    setLevel(".ts", 9);
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, CWD)).toBe(Math.round(DEFAULT_THRESHOLD_BYTES * DETAIL_FACTOR ** MAX_DETAIL));
  });

  test("off switch: stored level is ignored", () => {
    setLevel(".ts", 2);
    process.env.ASHLR_TUNING = "off";
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, CWD)).toBeUndefined();
  });

  test("other extensions and repos are untouched", () => {
    setLevel(".ts", 2);
    expect(tunedThreshold("ashlr__read", ".md", DEFAULT_THRESHOLD_BYTES, home, CWD)).toBeUndefined();
    expect(tunedThreshold("ashlr__read", ".ts", DEFAULT_THRESHOLD_BYTES, home, "/other")).toBeUndefined();
  });
});
