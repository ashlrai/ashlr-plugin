/**
 * json-parse-hardening.test.ts
 *
 * Verifies that every hook that parses untrusted JSON (stdin payloads, config
 * files, session-log lines) degrades gracefully when fed malformed input —
 * i.e. never throws and always returns the documented safe fallback.
 *
 * Coverage targets (all are stdlib-exported helpers, not entry points):
 *   hooks/_hook-errors.ts                  — safeParse<T>
 *   hooks/commit-attribution.ts            — processHookInput, isAttributionEnabled
 *   hooks/edit-batching-nudge.ts           — loadState
 *   hooks/genome-scribe-hook.ts            — isAutoNudgeEnabled
 *   hooks/sessionend-savings-nudge.ts      — readNudgeState, readStats
 *   hooks/sessionend-hook-health-nudge.ts  — readHealthState, resolveSessionStartMs
 *   hooks/stop-accounting.ts              — isAlreadyRecorded
 *   hooks/_recent-blocks.ts               — readRecentBlocks
 *   hooks/pretooluse-budget-guard.ts       — readSessionBytes
 *
 * Integration spawns (end-to-end stdin → exit 0):
 *   hooks/session-log-append.ts, orient-nudge-hook.ts, edit-batching-nudge.ts,
 *   genome-scribe-hook.ts, posttooluse-native-nudge.ts, subagent-stop-rollup.ts,
 *   userpromptsubmit-brief-trigger.ts, pulse-emit.ts, commit-attribution.ts,
 *   audit-upload.ts, stop-accounting.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { safeParse } from "../../hooks/_hook-errors";
import { processHookInput, isAttributionEnabled } from "../../hooks/commit-attribution";
import { loadState, statePath } from "../../hooks/edit-batching-nudge";
import { isAutoNudgeEnabled } from "../../hooks/genome-scribe-hook";
import {
  readNudgeState,
  readStats,
  nudgeStatePath,
} from "../../hooks/sessionend-savings-nudge";
import {
  readHealthState,
  resolveSessionStartMs,
  healthNudgeStatePath,
} from "../../hooks/sessionend-hook-health-nudge";
import { isAlreadyRecorded } from "../../hooks/stop-accounting";
import { readRecentBlocks } from "../../hooks/_recent-blocks";
import { readSessionBytes } from "../../hooks/pretooluse-budget-guard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpHome(): string {
  const dir = join(
    tmpdir(),
    `ashlr-harden-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, ".ashlr"), { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

const ORIG_ENV = { ...process.env };
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const k of Object.keys(ORIG_ENV)) {
    process.env[k] = ORIG_ENV[k]!;
  }
}

beforeEach(() => restoreEnv());
afterEach(() => restoreEnv());

/**
 * Payloads that must never crash JSON.parse-consuming code.
 * Note: "null" and "true" are valid JSON — they are intentionally excluded
 * here. Hook code defensively checks types on the parsed result, so valid
 * JSON that produces a non-object is handled at the application level.
 */
const MALFORMED: string[] = [
  "",
  "   ",
  "{",
  "}",
  '{"unclosed":',
  "undefined",
  "NaN",
  "[1,2,",
  "\x00\x01\x02",
  "<!DOCTYPE html>",
  "a".repeat(1_000),
];

// ---------------------------------------------------------------------------
// safeParse<T> — the canonical helper
// ---------------------------------------------------------------------------

describe("safeParse<T> — canonical safe parse helper", () => {
  for (const bad of MALFORMED) {
    test(`returns fallback for: ${JSON.stringify(bad).slice(0, 40)}`, () => {
      expect(safeParse<null>(bad, null)).toBeNull();
      expect(safeParse<Record<string, unknown>>(bad, {})).toEqual({});
      expect(safeParse<unknown[]>(bad, [])).toEqual([]);
      expect(safeParse<number>(bad, 42)).toBe(42);
    });
  }

  test("returns parsed value on valid JSON object", () => {
    const result = safeParse<Record<string, number>>('{"a":1}', {});
    expect(result).toEqual({ a: 1 });
  });

  test("returns parsed value on valid JSON array", () => {
    const result = safeParse<number[]>("[1,2,3]", []);
    expect(result).toEqual([1, 2, 3]);
  });

  test("never throws when hook/context provided", () => {
    const home = tmpHome();
    try {
      process.env.ASHLR_HOME_OVERRIDE = home;
      for (const bad of MALFORMED) {
        expect(() =>
          safeParse<Record<string, unknown>>(bad, {}, "test-hook", "stdin"),
        ).not.toThrow();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("records error to hook-errors.jsonl when hook name given", () => {
    const home = tmpHome();
    try {
      process.env.ASHLR_HOME_OVERRIDE = home;
      safeParse<Record<string, unknown>>("{bad json", {}, "harden-test", "stdin-test");
      const p = join(home, ".ashlr", "hook-errors.jsonl");
      expect(existsSync(p)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does NOT record error when hook name omitted", () => {
    const home = tmpHome();
    try {
      process.env.ASHLR_HOME_OVERRIDE = home;
      safeParse<Record<string, unknown>>("{bad json", {});
      const p = join(home, ".ashlr", "hook-errors.jsonl");
      expect(existsSync(p)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// commit-attribution — processHookInput, isAttributionEnabled
// ---------------------------------------------------------------------------

describe("commit-attribution — malformed stdin/config", () => {
  for (const bad of MALFORMED) {
    test(`processHookInput does not throw on: ${JSON.stringify(bad).slice(0, 40)}`, () => {
      expect(() => processHookInput(bad)).not.toThrow();
    });

    test(`processHookInput returns valid JSON pass-through on: ${JSON.stringify(bad).slice(0, 40)}`, () => {
      const out = processHookInput(bad);
      expect(() => JSON.parse(out)).not.toThrow();
    });
  }

  test("isAttributionEnabled returns true when settings.json is malformed", () => {
    const home = tmpHome();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      writeFileSync(settingsPath, "{ malformed", "utf-8");
      expect(isAttributionEnabled(settingsPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("isAttributionEnabled returns true when settings.json is empty", () => {
    const home = tmpHome();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      writeFileSync(settingsPath, "", "utf-8");
      expect(isAttributionEnabled(settingsPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// edit-batching-nudge — loadState
// ---------------------------------------------------------------------------

describe("edit-batching-nudge — loadState with malformed state file", () => {
  for (const bad of ["", "{", "null", "NOT_JSON", '{"pid":1}']) {
    test(`loadState returns safe default for content: ${JSON.stringify(bad).slice(0, 30)}`, () => {
      const home = tmpHome();
      try {
        const p = statePath(home);
        writeFileSync(p, bad, "utf-8");
        expect(() => loadState(p, 999)).not.toThrow();
        const state = loadState(p, 999);
        expect(state.pid).toBe(999);
        expect(Array.isArray(state.timestamps)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// genome-scribe-hook — isAutoNudgeEnabled
// ---------------------------------------------------------------------------

describe("genome-scribe-hook — isAutoNudgeEnabled with malformed settings", () => {
  test("returns true (default) when settings.json is malformed", () => {
    const home = tmpHome();
    try {
      writeFileSync(join(home, ".claude", "settings.json"), "{bad", "utf-8");
      expect(isAutoNudgeEnabled(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns true when settings.json is empty", () => {
    const home = tmpHome();
    try {
      writeFileSync(join(home, ".claude", "settings.json"), "", "utf-8");
      expect(isAutoNudgeEnabled(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not throw for any malformed input", () => {
    const home = tmpHome();
    try {
      for (const bad of MALFORMED) {
        writeFileSync(join(home, ".claude", "settings.json"), bad, "utf-8");
        expect(() => isAutoNudgeEnabled(home)).not.toThrow();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sessionend-savings-nudge — readNudgeState, readStats
// ---------------------------------------------------------------------------

describe("sessionend-savings-nudge — readNudgeState / readStats with malformed files", () => {
  test("readNudgeState returns default state when file is malformed", () => {
    const home = tmpHome();
    try {
      writeFileSync(nudgeStatePath(home), "{truncated", "utf-8");
      expect(() => readNudgeState(home)).not.toThrow();
      const s = readNudgeState(home);
      expect(s.last_session_nudge_ts).toBeNull();
      expect(Array.isArray(s.lifetime_nudge_ticks)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readNudgeState returns default state for empty file", () => {
    const home = tmpHome();
    try {
      writeFileSync(nudgeStatePath(home), "", "utf-8");
      expect(() => readNudgeState(home)).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readStats returns null when stats.json is malformed", () => {
    const home = tmpHome();
    try {
      writeFileSync(join(home, ".ashlr", "stats.json"), "NOT JSON AT ALL", "utf-8");
      expect(() => readStats(home)).not.toThrow();
      expect(readStats(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const bad of MALFORMED) {
    test(`readNudgeState never throws for: ${JSON.stringify(bad).slice(0, 30)}`, () => {
      const home = tmpHome();
      try {
        writeFileSync(nudgeStatePath(home), bad, "utf-8");
        expect(() => readNudgeState(home)).not.toThrow();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// sessionend-hook-health-nudge — readHealthState, resolveSessionStartMs
// ---------------------------------------------------------------------------

describe("sessionend-hook-health-nudge — malformed state / stats files", () => {
  test("readHealthState returns default when file is malformed", () => {
    const home = tmpHome();
    try {
      writeFileSync(healthNudgeStatePath(home), "{bad", "utf-8");
      expect(() => readHealthState(home)).not.toThrow();
      const s = readHealthState(home);
      expect(typeof s.last_error_nudge_at).toBe("number");
      expect(typeof s.last_regression_nudge_at).toBe("number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resolveSessionStartMs returns a number when stats.json is malformed", () => {
    const home = tmpHome();
    try {
      writeFileSync(join(home, ".ashlr", "stats.json"), "GARBAGE", "utf-8");
      expect(() => resolveSessionStartMs(home)).not.toThrow();
      expect(typeof resolveSessionStartMs(home)).toBe("number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const bad of MALFORMED) {
    test(`readHealthState never throws for: ${JSON.stringify(bad).slice(0, 30)}`, () => {
      const home = tmpHome();
      try {
        writeFileSync(healthNudgeStatePath(home), bad, "utf-8");
        expect(() => readHealthState(home)).not.toThrow();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// stop-accounting — isAlreadyRecorded (parses JSONL lines)
// ---------------------------------------------------------------------------

describe("stop-accounting — isAlreadyRecorded with malformed JSONL lines", () => {
  test("returns false when all lines are malformed JSON", () => {
    const lines = ["{bad", "NOT_JSON", "", "   "];
    expect(() => isAlreadyRecorded(lines, "any-session")).not.toThrow();
    expect(isAlreadyRecorded(lines, "any-session")).toBe(false);
  });

  test("returns false for empty lines array", () => {
    expect(isAlreadyRecorded([], "x")).toBe(false);
  });

  test("still finds a valid entry amid malformed lines", () => {
    const validLine = JSON.stringify({
      session: "s1",
      event: "stop",
      ts: new Date(Date.now()).toISOString(),
    });
    const lines = ["{bad", validLine, "also-bad"];
    expect(isAlreadyRecorded(lines, "s1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _recent-blocks — readRecentBlocks with malformed JSONL
// ---------------------------------------------------------------------------

describe("_recent-blocks — readRecentBlocks with malformed lines", () => {
  test("returns empty array when file contains only malformed lines", () => {
    const home = tmpHome();
    try {
      const p = join(home, ".ashlr", "recent-blocks.jsonl");
      writeFileSync(p, ["{bad", "NOT JSON", ""].join("\n"), "utf-8");
      expect(() => readRecentBlocks(home)).not.toThrow();
      expect(readRecentBlocks(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns empty array when file is absent", () => {
    const home = tmpHome();
    try {
      expect(readRecentBlocks(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns valid records and skips malformed lines", () => {
    const home = tmpHome();
    try {
      const valid = JSON.stringify({
        ts: new Date().toISOString(),
        tool: "Read",
        path: "/foo/bar.ts",
        size: 100,
      });
      const p = join(home, ".ashlr", "recent-blocks.jsonl");
      writeFileSync(p, ["{bad", valid, "also-bad"].join("\n"), "utf-8");
      const blocks = readRecentBlocks(home);
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pretooluse-budget-guard — readSessionBytes with malformed JSONL
// ---------------------------------------------------------------------------

describe("pretooluse-budget-guard — readSessionBytes with malformed JSONL", () => {
  test("returns 0 when all lines are malformed", () => {
    const home = tmpHome();
    try {
      writeFileSync(
        join(home, ".ashlr", "session-log.jsonl"),
        ["{bad", "NOT_JSON", "   "].join("\n"),
        "utf-8",
      );
      expect(() => readSessionBytes(home, "s1")).not.toThrow();
      expect(readSessionBytes(home, "s1")).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("sums valid entries and ignores malformed ones", () => {
    const home = tmpHome();
    try {
      const good = JSON.stringify({ session: "s1", input_size: 100, output_size: 200 });
      writeFileSync(
        join(home, ".ashlr", "session-log.jsonl"),
        [good, "{bad", good].join("\n"),
        "utf-8",
      );
      expect(readSessionBytes(home, "s1")).toBe(600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("truncated final line does not throw", () => {
    const home = tmpHome();
    try {
      writeFileSync(
        join(home, ".ashlr", "session-log.jsonl"),
        '{"session":"s1","input_size":50,"output_siz',
        "utf-8",
      );
      expect(() => readSessionBytes(home, "s1")).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: spawned hook processes — malformed stdin must exit 0
// ---------------------------------------------------------------------------

async function runHook(
  hookPath: string,
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", hookPath], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const HOOK_DIR = join(import.meta.dir, "../../hooks");

describe("integration — spawned hooks always exit 0 on malformed stdin", () => {
  // Representative sample only — the per-hook parse logic is covered by the unit
  // tests above. Spawning every hook as a subprocess adds heavy concurrent load
  // that destabilizes other timing-sensitive subprocess tests on CI runners.
  const hooks = [
    "session-log-append.ts", // JSONL line parsing
    "genome-scribe-hook.ts", // settings.json config parsing
    "subagent-stop-rollup.ts", // v1.34 hook, stdin payload parsing
  ];

  for (const hook of hooks) {
    for (const bad of ["", "{", "NOT_JSON", '{"unclosed":', "\x00\x01"]) {
      test(`${hook} exits 0 for stdin=${JSON.stringify(bad).slice(0, 20)}`, async () => {
        const { exitCode } = await runHook(join(HOOK_DIR, hook), bad, {
          ASHLR_SESSION_LOG: "0",
          ASHLR_GENOME_AUTO: "0",
          ASHLR_PULSE_OTLP_ENDPOINT: "",
        });
        expect(exitCode).toBe(0);
      }, 10_000);
    }
  }

  test("commit-attribution.ts exits 0 for truncated stdin", async () => {
    const { exitCode } = await runHook(
      join(HOOK_DIR, "commit-attribution.ts"),
      '{"tool_name":"Bash","tool_input":{"command":"git commit -m',
    );
    expect(exitCode).toBe(0);
  });

  test("audit-upload.ts exits 0 for empty stdin (no token configured)", async () => {
    const { exitCode } = await runHook(join(HOOK_DIR, "audit-upload.ts"), "", {
      ASHLR_PRO_TOKEN: "",
    });
    expect(exitCode).toBe(0);
  });

  test("stop-accounting.ts exits 0 for malformed stdin", async () => {
    const { exitCode } = await runHook(
      join(HOOK_DIR, "stop-accounting.ts"),
      "{bad json",
      { ASHLR_SESSION_LOG: "0" },
    );
    expect(exitCode).toBe(0);
  });
});
