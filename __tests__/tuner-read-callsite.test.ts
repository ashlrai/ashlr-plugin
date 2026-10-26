/**
 * Call-site test: ashlrRead passes the tuned summarize threshold through to
 * summarizeIfLarge (and passes none at level 0). summarizeIfLarge is replaced
 * with a recorder via mock.module, so no summarizer or provider runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import * as realSummarize from "../servers/_summarize";

const calls: Array<{ thresholdBytes?: number; toolName?: string }> = [];
mock.module("../servers/_summarize", () => ({
  ...realSummarize,
  summarizeIfLarge: async (text: string, opts: { thresholdBytes?: number; toolName?: string }) => {
    calls.push({ thresholdBytes: opts.thresholdBytes, toolName: opts.toolName });
    return { text, summarized: false, wasCached: false, fellBack: false, outputBytes: Buffer.byteLength(text) };
  },
}));

const { ashlrRead } = await import("../servers/read-server");
const { DETAIL_FACTOR, tuningPath } = await import("../servers/_tuner");
const { DEFAULT_THRESHOLD_BYTES } = realSummarize;

const ENV = { home: process.env.ASHLR_HOME_OVERRIDE, tuning: process.env.ASHLR_TUNING };
let home: string;
let repo: string;
let prevCwd: string;
let n = 0;

beforeAll(() => { prevCwd = process.cwd(); });
afterAll(() => {
  process.chdir(prevCwd);
  if (ENV.home === undefined) delete process.env.ASHLR_HOME_OVERRIDE; else process.env.ASHLR_HOME_OVERRIDE = ENV.home;
  if (ENV.tuning === undefined) delete process.env.ASHLR_TUNING; else process.env.ASHLR_TUNING = ENV.tuning;
});
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ashlr-callsite-home-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ashlr-callsite-repo-")));
  process.chdir(repo);
  process.env.ASHLR_HOME_OVERRIDE = home;
  delete process.env.ASHLR_TUNING;
  calls.length = 0;
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function setReadLevel(ext: string, level: number) {
  const p = tuningPath(home, repo); // same repo key ashlrRead uses: process.cwd()
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ashlr__read: { [ext]: { level, atSample: 40 } } }));
}

async function readFresh(): Promise<void> {
  const name = `f${n++}.txt`; // unique name: never a read-cache hit
  writeFileSync(join(repo, name), "line of text\n".repeat(2000));
  await ashlrRead({ path: name, mode: "snip" });
}

function readCalls() {
  return calls.filter((c) => c.toolName === "ashlr__read");
}

describe("ashlrRead call site: tuned summarize threshold", () => {
  test("level 0 (no state) passes no thresholdBytes", async () => {
    await readFresh();
    expect(readCalls().length).toBe(1);
    expect(readCalls()[0]!.thresholdBytes).toBeUndefined();
  });

  test("stored level 0 passes no thresholdBytes", async () => {
    setReadLevel(".txt", 0);
    await readFresh();
    expect(readCalls()[0]!.thresholdBytes).toBeUndefined();
  });

  test("+1 passes the raised threshold", async () => {
    setReadLevel(".txt", 1);
    await readFresh();
    expect(readCalls()[0]!.thresholdBytes).toBe(Math.round(DEFAULT_THRESHOLD_BYTES * DETAIL_FACTOR));
  });

  test("negative level and ASHLR_TUNING=off pass no thresholdBytes", async () => {
    setReadLevel(".txt", -2);
    await readFresh();
    process.env.ASHLR_TUNING = "off";
    setReadLevel(".txt", 2);
    await readFresh();
    expect(readCalls().map((c) => c.thresholdBytes)).toEqual([undefined, undefined]);
  });
});
