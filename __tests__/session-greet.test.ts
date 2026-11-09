/**
 * session-greet.test.ts — tests for the SessionStart greeting state machine.
 *
 * scripts/session-greet.ts renders the human-facing welcome on every Claude
 * Code session and owns the session-state file that decides which of the
 * three greetings (first-run / normal / weekly) appears. It was written with
 * test injection points (GreetOpts.stats/ollamaDetector/write) but had no
 * test file, so mode selection, the per-cwd genome nudge throttle and the
 * "state persists even under ASHLR_QUIET" contract were all unpinned.
 *
 * Hermetic: every test runs against a mkdtemp HOME; NO_COLOR=1 keeps the
 * plain-text render paths deterministic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  greet,
  loadSessionState,
  loadStats,
  maybeGenomeSuggestion,
  pickMode,
  renderFirstRun,
  renderNormal,
  renderWeekly,
  saveSessionState,
  sessionStatePath,
  type SessionState,
} from "../scripts/session-greet.ts";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

/** NOW used across the greet tests; the default lastWeeklySummaryAt sits one
 * day before it so un-overridden states land in "normal" mode. */
const NOW = new Date("2026-11-08T12:00:00.000Z");

function setState(overrides: Partial<SessionState>): SessionState {
  return {
    firstRunAt: "2026-10-01T00:00:00.000Z",
    lastRunAt: "2026-11-07T12:00:00.000Z",
    runCount: 5,
    lastWeeklySummaryAt: "2026-11-07T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-session-greet-"));
  for (const key of ["NO_COLOR", "FORCE_COLOR", "ASHLR_QUIET", "ASHLR_NO_GREET"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  delete process.env.ASHLR_QUIET;
  delete process.env.ASHLR_NO_GREET;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("pickMode", () => {
  test("no state is a first-run", () => {
    expect(pickMode(null, NOW)).toBe("first-run");
  });

  test("an unparseable lastWeeklySummaryAt falls back to weekly", () => {
    expect(pickMode(setState({ lastWeeklySummaryAt: "not-a-date" }), NOW)).toBe("weekly");
  });

  test("7 days or more since the last weekly summary earns another weekly", () => {
    expect(pickMode(setState({ lastWeeklySummaryAt: "2026-11-01T12:00:00.000Z" }), NOW)).toBe("weekly");
    expect(pickMode(setState({ lastWeeklySummaryAt: "2026-11-01T12:00:01.000Z" }), NOW)).toBe("normal");
  });

  test("runCount hitting a multiple of 20 earns a weekly even within 7 days", () => {
    expect(pickMode(setState({ runCount: 20 }), NOW)).toBe("weekly");
    expect(pickMode(setState({ runCount: 19 }), NOW)).toBe("normal");
    expect(pickMode(setState({ runCount: 21 }), NOW)).toBe("normal");
  });

  test("runCount 0 never triggers the cadence rule", () => {
    expect(pickMode(setState({ runCount: 0 }), NOW)).toBe("normal");
  });
});

describe("state + stats file IO", () => {
  test("loadSessionState returns null when the file is missing", () => {
    expect(loadSessionState(home)).toBeNull();
  });

  test("loadSessionState treats corrupt JSON as a first-run", () => {
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    writeFileSync(sessionStatePath(home), "{ nope");
    expect(loadSessionState(home)).toBeNull();
  });

  test("loadSessionState rejects a partial shape instead of guessing", () => {
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    const { runCount: _dropped, ...partial } = setState({});
    void _dropped;
    writeFileSync(sessionStatePath(home), JSON.stringify(partial));
    expect(loadSessionState(home)).toBeNull();
  });

  test("saveSessionState round-trips through loadSessionState", () => {
    const state = setState({ lastGenomeSuggestByCwd: { "/tmp/proj": "2026-11-02T00:00:00.000Z" } });
    saveSessionState(state, home);
    expect(loadSessionState(home)).toEqual(state);
  });

  test("a missing lastGenomeSuggestByCwd defaults to an empty table", () => {
    const state = setState({});
    saveSessionState({ firstRunAt: state.firstRunAt, lastRunAt: state.lastRunAt, runCount: state.runCount, lastWeeklySummaryAt: state.lastWeeklySummaryAt }, home);
    expect(loadSessionState(home)?.lastGenomeSuggestByCwd).toEqual({});
  });

  test("loadStats returns null for missing and corrupt stats files", () => {
    expect(loadStats(home)).toBeNull();
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    writeFileSync(join(home, ".ashlr", "stats.json"), "[");
    expect(loadStats(home)).toBeNull();
  });
});

describe("renderNormal", () => {
  test("no usage yet gets the gentle poke, not a blank stat", () => {
    expect(renderNormal(null)).toContain("no savings yet");
    expect(renderNormal({})).toContain("no savings yet");
  });

  test("renders last-session and lifetime totals together", () => {
    const out = renderNormal({
      session: { tokensSaved: 1234 },
      lifetime: { tokensSaved: 2_500_000 },
    });
    expect(out).toContain("last session saved 1.2K tok");
    expect(out).toContain("Lifetime: 2.50M");
    expect(out).toContain("$");
  });

  test("lifetime-only savings skip the last-session clause", () => {
    const out = renderNormal({ lifetime: { tokensSaved: 50_000 } });
    expect(out).toContain("no savings last session");
    expect(out).toContain("50.0K");
  });
});

describe("renderWeekly", () => {
  function byDay(tokens: Record<string, number>) {
    return Object.fromEntries(Object.entries(tokens).map(([day, tokensSaved]) => [day, { tokensSaved }]));
  }

  test("sums the trailing 7 UTC days, active days and the top tool", () => {
    const out = renderWeekly(
      {
        lifetime: {
          byDay: byDay({
            "2026-11-03": 1_000,
            "2026-11-05": 2_000,
            "2026-11-08": 500,
            // Outside the 7-day window — must not count.
            "2026-10-20": 999_999,
          }),
          byTool: { ashlr__grep: { tokensSaved: 9_000 }, ashlr__read: { tokensSaved: 4_000 } },
        },
      },
      NOW,
    );
    expect(out).toContain("weekly: 3.5K tok");
    expect(out).toContain("$");
    expect(out).toContain("over 3/7 days");
    expect(out).toContain("top: ashlr__grep (9.0K)");
    expect(out).toContain("/ashlr:ashlr-dashboard");
    // 999_999 tokens would render as "1000.0K" if the stale day leaked in.
    expect(out).not.toContain("1000.0K");
  });

  test("empty stats render zero totals without a top tool", () => {
    const out = renderWeekly(null, NOW);
    expect(out).toContain("weekly: 0 tok");
    expect(out).toContain("over 0/7 days");
    expect(out).not.toContain("top:");
  });
});

describe("fancy-mode rendering (FORCE_COLOR)", () => {
  // Strip ANSI so structural assertions see the visible text; color presence
  // is asserted separately.
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
  });

  test("first-run renders a bordered box with ANSI color", () => {
    const out = renderFirstRun({ ollama: false, hasGenome: false });
    expect(out).toContain("\x1b[");
    const text = plain(out);
    expect(text).toContain("╔");
    expect(text).toContain("Welcome to ashlr");
    expect(text).toContain("/ashlr:ashlr-genome-init");
    expect(text).toContain("Ollama");
  });

  test("first-run swaps the Ollama hint and genome step on detection", () => {
    const noOllama = plain(renderFirstRun({ ollama: false, hasGenome: true }));
    expect(noOllama).toContain("Genome detected");
    expect(noOllama).not.toContain("/ashlr:ashlr-genome-init in a project");
    const withOllama = plain(renderFirstRun({ ollama: true, hasGenome: false }));
    expect(withOllama).toContain("Ollama detected — try /ashlr:ashlr-genome-init --summarize");
  });

  test("weekly renders the sparkline, totals and dashboard pointer", () => {
    const NOW2 = new Date("2026-11-08T12:00:00.000Z");
    const out = renderWeekly(
      {
        lifetime: {
          byDay: {
            "2026-11-02": { tokensSaved: 0 },
            "2026-11-03": { tokensSaved: 4_000_000 },
            "2026-11-08": { tokensSaved: 2_000_000 },
          },
          byTool: { ashlr__read: { tokensSaved: 6_000_000 } },
        },
      },
      NOW2,
    );
    const text = plain(out);
    expect(text).toContain("Weekly summary");
    // Zero day floors to ▁; the max day uses the full block.
    expect(text).toContain("▁");
    expect(text).toContain("█");
    expect(text).toContain("last 7 days");
    expect(text).toContain("ashlr__read");
    expect(text).toContain("/ashlr:ashlr-dashboard");
  });

  test("usd formatting covers the <1c, sub-$1..$100 and >= $100 tiers", () => {
    expect(plain(renderNormal({ lifetime: { tokensSaved: 1 } }))).toContain("($0.0000)");
    expect(plain(renderNormal({ lifetime: { tokensSaved: 20_000_000 } }))).toContain("($50.00)");
    expect(plain(renderNormal({ lifetime: { tokensSaved: 200_000_000 } }))).toContain("($500)");
  });
});

describe("maybeGenomeSuggestion", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(home, "proj");
    mkdirSync(projectDir);
  });

  test("new users (runCount <= 2) are not nudged yet", () => {
    const state = setState({ runCount: 2 });
    const result = maybeGenomeSuggestion(state, projectDir, NOW);
    expect(result.suggest).toBe(false);
    expect(result.stateMutated).toBe(state);
  });

  test("a project that already has a genome is never nudged", () => {
    mkdirSync(join(projectDir, ".ashlrcode", "genome"), { recursive: true });
    expect(maybeGenomeSuggestion(setState({ runCount: 10 }), projectDir, NOW).suggest).toBe(false);
  });

  test("suggests once, then throttles per cwd for a week", () => {
    const state = setState({ runCount: 10 });
    const first = maybeGenomeSuggestion(state, projectDir, NOW);
    expect(first.suggest).toBe(true);
    expect(first.stateMutated.lastGenomeSuggestByCwd?.[projectDir]).toBe(NOW.toISOString());

    const again = maybeGenomeSuggestion(first.stateMutated, projectDir, new Date("2026-11-10T12:00:00.000Z"));
    expect(again.suggest).toBe(false);
    expect(again.stateMutated).toBe(first.stateMutated);

    const afterAWeek = maybeGenomeSuggestion(first.stateMutated, projectDir, new Date("2026-11-15T12:00:00.000Z"));
    expect(afterAWeek.suggest).toBe(true);
  });

  test("the throttle is per cwd", () => {
    const otherDir = join(home, "other");
    mkdirSync(otherDir);
    const nudged = maybeGenomeSuggestion(setState({ runCount: 10 }), projectDir, NOW).stateMutated;
    expect(maybeGenomeSuggestion(nudged, otherDir, new Date("2026-11-09T12:00:00.000Z")).suggest).toBe(true);
  });
});

describe("greet", () => {
  const NOW = new Date("2026-11-08T12:00:00.000Z");
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(home, "proj");
    mkdirSync(projectDir);
  });

  test("a missing state file renders the first-run welcome and seeds state", () => {
    const writes: string[] = [];
    const result = greet({
      home,
      cwd: projectDir,
      now: NOW,
      stats: null,
      ollamaDetector: () => false,
      write: (s) => writes.push(s),
    });
    expect(result.mode).toBe("first-run");
    expect(result.printed).toBe(true);
    expect(result.genomeSuggested).toBe(false);
    expect(writes.join("")).toContain("Welcome to ashlr");
    const onDisk = loadSessionState(home);
    expect(onDisk).toMatchObject({ runCount: 1, firstRunAt: NOW.toISOString(), lastRunAt: NOW.toISOString() });
  });

  test("a normal run increments runCount and reports prior-session savings", () => {
    saveSessionState(setState({ runCount: 5 }), home);
    const writes: string[] = [];
    const result = greet({
      home,
      cwd: projectDir,
      now: NOW,
      stats: { session: { tokensSaved: 800 }, lifetime: { tokensSaved: 9_000 } },
      write: (s) => writes.push(s),
    });
    expect(result.mode).toBe("normal");
    expect(writes.join("")).toContain("last session saved 800 tok");
    expect(result.state.runCount).toBe(6);
    // runCount 6 > 2 and the project has no genome → the nudge fires and is recorded.
    expect(result.genomeSuggested).toBe(true);
    expect(result.state.lastGenomeSuggestByCwd?.[projectDir]).toBe(NOW.toISOString());
  });

  test("an existing genome suppresses the genome nudge", () => {
    mkdirSync(join(projectDir, ".ashlrcode", "genome"), { recursive: true });
    saveSessionState(setState({ runCount: 5 }), home);
    const result = greet({ home, cwd: projectDir, now: NOW, stats: null, write: () => {} });
    expect(result.mode).toBe("normal");
    expect(result.genomeSuggested).toBe(false);
    expect(result.state.lastGenomeSuggestByCwd).toEqual({});
  });

  test("a runCount landing on 20 renders the weekly summary and stamps it", () => {
    saveSessionState(setState({ runCount: 19 }), home);
    const writes: string[] = [];
    const result = greet({
      home,
      cwd: projectDir,
      now: NOW,
      stats: { lifetime: { byDay: { [NOW.toISOString().slice(0, 10)]: { tokensSaved: 1_000 } } } },
      write: (s) => writes.push(s),
    });
    expect(result.mode).toBe("weekly");
    expect(writes.join("")).toContain("weekly:");
    expect(result.state.lastWeeklySummaryAt).toBe(NOW.toISOString());
  });

  test("ASHLR_QUIET skips output but still persists state", () => {
    process.env.ASHLR_QUIET = "1";
    saveSessionState(setState({ runCount: 5 }), home);
    const writes: string[] = [];
    const result = greet({ home, cwd: projectDir, now: NOW, stats: null, write: (s) => writes.push(s) });
    expect(result.printed).toBe(false);
    expect(writes).toHaveLength(0);
    expect(loadSessionState(home)?.runCount).toBe(6);
  });

  test("ASHLR_NO_GREET skips output but still persists state", () => {
    process.env.ASHLR_NO_GREET = "1";
    saveSessionState(setState({ runCount: 5 }), home);
    const result = greet({ home, cwd: projectDir, now: NOW, stats: null, write: () => {} });
    expect(result.printed).toBe(false);
    expect(existsSync(sessionStatePath(home))).toBe(true);
    expect(readFileSync(sessionStatePath(home), "utf-8")).toContain("\"runCount\": 6");
  });
});
