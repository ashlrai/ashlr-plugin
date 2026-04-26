/**
 * __tests__/proactive-nudges.test.ts
 *
 * Tests for Track GG: proactive missed-save nudges.
 *
 * Coverage:
 *   1. posttooluse-native-nudge.ts (hook subprocess)
 *      - native Read in nudge mode → emits additionalContext
 *      - native Read in redirect mode → no double-nudge
 *      - throttle: second call within 60s → no nudge
 *      - repeat-offender: 3rd call within 10min → escalated message
 *      - small file → no nudge (below threshold)
 *      - ASHLR_SESSION_LOG=0 → no nudge
 *   2. _nudge-throttle.ts (unit)
 *      - recordNativeCall honours 1-per-minute throttle
 *      - repeat-offender fires at 3rd call
 *      - escalation throttled separately
 *   3. renderTopOpportunitySection (unit, savings-report-extras.ts)
 *      - genome missing + heavy grep → genome hint
 *      - no LLM provider + many fallbacks → llm hint
 *      - nudge mode + low conversion → redirect hint
 *      - all conditions absent → empty string
 *      - caps at 2 hints
 *   4. set-hook-mode.ts (subprocess + unit)
 *      - writes hookMode to config.json
 *      - validates input (invalid mode → exit 1)
 *      - preserves existing config keys
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  recordNativeCall,
  THROTTLE_MS,
  REPEAT_WINDOW_MS,
  REPEAT_THRESHOLD,
} from "../hooks/_nudge-throttle";

import {
  renderTopOpportunitySection,
  type OpportunityContext,
} from "../scripts/savings-report-extras";

import { setHookMode } from "../scripts/set-hook-mode";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NATIVE_NUDGE_HOOK = join(import.meta.dir, "..", "hooks", "posttooluse-native-nudge.ts");
const SET_HOOK_MODE_SCRIPT = join(import.meta.dir, "..", "scripts", "set-hook-mode.ts");

async function runHook(
  script: string,
  stdin: string,
  env?: Record<string, string>,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", script],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: (() => {
      // Strip existing mode/enforce so tests are isolated.
      const { ASHLR_HOOK_MODE: _hm, ASHLR_ENFORCE: _en, ...clean } = process.env;
      void _hm; void _en;
      return { ...clean, ...(env ?? {}) };
    })(),
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runScript(
  script: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", script, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// posttooluse-native-nudge.ts — hook subprocess tests
// ---------------------------------------------------------------------------

describe("posttooluse-native-nudge hook", () => {
  let tmp: string;
  let fakeHome: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-nn-"));
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-nn-home-"));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("native Read on large file in nudge mode → emits additionalContext", async () => {
    const path = join(tmp, "big.ts");
    await writeFile(path, "x".repeat(5000));

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const out = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(typeof out.additionalContext).toBe("string");
    expect(out.additionalContext as string).toContain("[ashlr nudge]");
    expect(out.additionalContext as string).toContain("ashlr__read");
    expect(out.additionalContext as string).toContain("big.ts");
    // PostToolUse nudge must not set permissionDecision.
    expect(out.permissionDecision).toBeUndefined();
  });

  test("native Read in redirect mode → no nudge (PreToolUse already blocked)", async () => {
    const path = join(tmp, "big.ts");
    await writeFile(path, "x".repeat(5000));

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "redirect", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    // Should be empty object (pass-through).
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const out = (parsed.hookSpecificOutput ?? parsed) as Record<string, unknown>;
    expect(out.additionalContext).toBeUndefined();
  });

  test("native Read in off mode → no nudge", async () => {
    const path = join(tmp, "big.ts");
    await writeFile(path, "x".repeat(5000));

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "off", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const out = (parsed.hookSpecificOutput ?? parsed) as Record<string, unknown>;
    expect(out.additionalContext).toBeUndefined();
  });

  test("small file (<=2KB) → no nudge", async () => {
    const path = join(tmp, "tiny.ts");
    await writeFile(path, "x".repeat(100));

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const out = (parsed.hookSpecificOutput ?? parsed) as Record<string, unknown>;
    expect(out.additionalContext).toBeUndefined();
  });

  test("ASHLR_SESSION_LOG=0 → no nudge", async () => {
    const path = join(tmp, "big.ts");
    await writeFile(path, "x".repeat(5000));

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome, ASHLR_SESSION_LOG: "0" },
      tmp,
    );

    expect(exitCode).toBe(0);
    // The hook exits early before writing JSON output when ASHLR_SESSION_LOG=0.
    // It writes "{}" to stdout.
    expect(stdout.trim()).toBe("{}");
  });

  test("native Grep in nudge mode → emits additionalContext", async () => {
    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "needle", path: tmp } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const out = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(typeof out.additionalContext).toBe("string");
    expect(out.additionalContext as string).toContain("[ashlr nudge]");
    expect(out.additionalContext as string).toContain("ashlr__grep");
  });
});

// ---------------------------------------------------------------------------
// _nudge-throttle.ts — unit tests
// ---------------------------------------------------------------------------

describe("_nudge-throttle recordNativeCall", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-throttle-"));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("first call → emitNudge=true", () => {
    const now = Date.now();
    const result = recordNativeCall("Read", now, fakeHome);
    expect(result.emitNudge).toBe(true);
    expect(result.emitEscalation).toBe(false);
  });

  test("second call within throttle window → no nudge", () => {
    const now = Date.now();
    recordNativeCall("Read", now, fakeHome);
    const result = recordNativeCall("Read", now + 1000, fakeHome); // 1s later
    expect(result.emitNudge).toBe(false);
    expect(result.emitEscalation).toBe(false);
  });

  test("call after throttle window expires → emitNudge=true again", () => {
    const now = Date.now();
    recordNativeCall("Read", now, fakeHome);
    const result = recordNativeCall("Read", now + THROTTLE_MS + 1, fakeHome);
    expect(result.emitNudge).toBe(true);
    expect(result.emitEscalation).toBe(false);
  });

  test("3rd call within 10min window → emitEscalation=true", () => {
    const now = Date.now();
    // First two calls.
    recordNativeCall("Grep", now, fakeHome);
    recordNativeCall("Grep", now + THROTTLE_MS + 100, fakeHome); // past throttle
    // Third call — should escalate.
    const result = recordNativeCall("Grep", now + THROTTLE_MS * 2 + 200, fakeHome);
    expect(result.emitEscalation).toBe(true);
    expect(result.emitNudge).toBe(false);
    expect(result.recentCallCount).toBeGreaterThanOrEqual(REPEAT_THRESHOLD);
  });

  test("calls older than 10min don't count toward repeat threshold", () => {
    const now = Date.now();
    // Two old calls (beyond the 10-minute window).
    recordNativeCall("Grep", now - REPEAT_WINDOW_MS - 2000, fakeHome);
    recordNativeCall("Grep", now - REPEAT_WINDOW_MS - 1000, fakeHome);
    // One fresh call — should NOT escalate (only 1 recent call).
    const result = recordNativeCall("Grep", now, fakeHome);
    expect(result.emitEscalation).toBe(false);
    expect(result.recentCallCount).toBe(1);
  });

  test("escalation throttled — second escalation within 60s suppressed", () => {
    const now = Date.now();
    // Seed state directly: 2 recent calls already, last nudge long ago.
    // Then make 2 more calls spaced > THROTTLE_MS apart to get escalation on the 3rd total.
    // Call 1: emits nudge (fresh start)
    recordNativeCall("Grep", now, fakeHome);
    // Call 2: past throttle window — emits nudge again, now 2 recent calls.
    recordNativeCall("Grep", now + THROTTLE_MS + 100, fakeHome);
    // Call 3: past throttle again, 3 recent calls → escalation fires.
    const first = recordNativeCall("Grep", now + THROTTLE_MS * 2 + 200, fakeHome);
    expect(first.emitEscalation).toBe(true);
    // Call 4: immediately after escalation — throttle is reset, should not escalate/nudge.
    const second = recordNativeCall("Grep", now + THROTTLE_MS * 2 + 300, fakeHome);
    expect(second.emitEscalation).toBe(false);
    expect(second.emitNudge).toBe(false);
  });

  test("ASHLR_SESSION_LOG=0 → no nudge, no state written", async () => {
    const origLog = process.env.ASHLR_SESSION_LOG;
    process.env.ASHLR_SESSION_LOG = "0";
    try {
      const result = recordNativeCall("Read", Date.now(), fakeHome);
      expect(result.emitNudge).toBe(false);
      expect(result.emitEscalation).toBe(false);
      expect(existsSync(join(fakeHome, ".ashlr", "nudge-throttle.json"))).toBe(false);
    } finally {
      if (origLog === undefined) delete process.env.ASHLR_SESSION_LOG;
      else process.env.ASHLR_SESSION_LOG = origLog;
    }
  });
});

// ---------------------------------------------------------------------------
// renderTopOpportunitySection — unit tests
// ---------------------------------------------------------------------------

describe("renderTopOpportunitySection", () => {
  const baseCtx: OpportunityContext = {
    noGenome: false,
    weeklyGrepCalls: 0,
    hookMode: "redirect",
    conversionPct: 75,
    fallbackCount: 0,
    hasLlmProvider: true,
  };

  test("no conditions met → empty string", () => {
    expect(renderTopOpportunitySection(baseCtx)).toBe("");
  });

  test("undefined → empty string", () => {
    expect(renderTopOpportunitySection(undefined)).toBe("");
  });

  test("genome missing + >5 grep calls → genome hint", () => {
    const ctx: OpportunityContext = { ...baseCtx, noGenome: true, weeklyGrepCalls: 6 };
    const out = renderTopOpportunitySection(ctx);
    expect(out).toContain("top opportunities:");
    expect(out).toContain("/ashlr-genome-init");
    expect(out).toContain("6 grep calls");
  });

  test("genome missing but <=5 grep calls → no hint", () => {
    const ctx: OpportunityContext = { ...baseCtx, noGenome: true, weeklyGrepCalls: 5 };
    expect(renderTopOpportunitySection(ctx)).toBe("");
  });

  test("no LLM provider + >10 fallbacks → llm hint", () => {
    const ctx: OpportunityContext = { ...baseCtx, hasLlmProvider: false, fallbackCount: 11 };
    const out = renderTopOpportunitySection(ctx);
    expect(out).toContain("top opportunities:");
    expect(out).toContain("install-onnx-model");
    expect(out).toContain("ANTHROPIC_API_KEY");
  });

  test("no LLM provider but <=10 fallbacks → no hint", () => {
    const ctx: OpportunityContext = { ...baseCtx, hasLlmProvider: false, fallbackCount: 10 };
    expect(renderTopOpportunitySection(ctx)).toBe("");
  });

  test("nudge mode + <50% conversion → redirect hint", () => {
    const ctx: OpportunityContext = { ...baseCtx, hookMode: "nudge", conversionPct: 30 };
    const out = renderTopOpportunitySection(ctx);
    expect(out).toContain("top opportunities:");
    expect(out).toContain("set-hook-mode.ts redirect");
    expect(out).toContain("30%");
  });

  test("nudge mode + >=50% conversion → no redirect hint", () => {
    const ctx: OpportunityContext = { ...baseCtx, hookMode: "nudge", conversionPct: 50 };
    expect(renderTopOpportunitySection(ctx)).toBe("");
  });

  test("all 3 conditions active → capped at 2 hints", () => {
    const ctx: OpportunityContext = {
      noGenome: true,
      weeklyGrepCalls: 10,
      hasLlmProvider: false,
      fallbackCount: 15,
      hookMode: "nudge",
      conversionPct: 20,
    };
    const out = renderTopOpportunitySection(ctx);
    expect(out).toContain("top opportunities:");
    // Count bullet items (each starts with "  ")
    const items = out.split("\n").filter((l) => l.startsWith("  "));
    expect(items.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// set-hook-mode.ts — unit + subprocess tests
// ---------------------------------------------------------------------------

describe("setHookMode (unit)", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-shm-"));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("writes hookMode to config.json", async () => {
    setHookMode("redirect", fakeHome);
    const raw = await readFile(join(fakeHome, ".ashlr", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.hookMode).toBe("redirect");
  });

  test("nudge mode written correctly", async () => {
    setHookMode("nudge", fakeHome);
    const raw = await readFile(join(fakeHome, ".ashlr", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.hookMode).toBe("nudge");
  });

  test("off mode written correctly", async () => {
    setHookMode("off", fakeHome);
    const raw = await readFile(join(fakeHome, ".ashlr", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.hookMode).toBe("off");
  });

  test("preserves other config keys", async () => {
    await writeFile(
      join(fakeHome, ".ashlr", "config.json"),
      JSON.stringify({ existingKey: "hello", hookMode: "nudge" }),
    );
    setHookMode("redirect", fakeHome);
    const raw = await readFile(join(fakeHome, ".ashlr", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.existingKey).toBe("hello");
    expect(cfg.hookMode).toBe("redirect");
  });

  test("overwrites corrupt config without throwing", async () => {
    await writeFile(join(fakeHome, ".ashlr", "config.json"), "{not json");
    expect(() => setHookMode("redirect", fakeHome)).not.toThrow();
    const raw = await readFile(join(fakeHome, ".ashlr", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.hookMode).toBe("redirect");
  });
});

describe("set-hook-mode.ts CLI (subprocess)", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-shm-cli-"));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("valid mode → exit 0, prints confirmation", async () => {
    const { stdout, exitCode } = await runScript(
      SET_HOOK_MODE_SCRIPT,
      ["redirect"],
      { HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ashlr hook mode set to redirect");
    expect(stdout).toContain("Restart Claude Code");
  });

  test("invalid mode → exit 1, error on stderr", async () => {
    const { stderr, exitCode } = await runScript(
      SET_HOOK_MODE_SCRIPT,
      ["bogus"],
      { HOME: fakeHome },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid hook mode");
  });

  test("no arg → exit 1", async () => {
    const { exitCode } = await runScript(SET_HOOK_MODE_SCRIPT, [], { HOME: fakeHome });
    expect(exitCode).toBe(1);
  });

  test("writes config.json that getHookMode() can read", async () => {
    const { exitCode } = await runScript(
      SET_HOOK_MODE_SCRIPT,
      ["nudge"],
      { HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const raw = await readFile(join(fakeHome, ".ashlr", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.hookMode).toBe("nudge");
  });
});

// ---------------------------------------------------------------------------
// repeat-offender escalation text — end-to-end via hook subprocess
// ---------------------------------------------------------------------------

describe("posttooluse-native-nudge — repeat-offender escalation", () => {
  let tmp: string;
  let fakeHome: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-rpt-"));
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-rpt-home-"));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("3rd Grep within 10min triggers escalated message via throttle module", async () => {
    // Pre-seed the throttle state: 2 Grep calls already in window, last nudge
    // was > 60s ago so the 3rd call will escalate.
    const now = Date.now();
    const state = {
      lastNudgeAt: now - THROTTLE_MS - 1,
      lastEscalationAt: 0,
      recentCalls: {
        Grep: [now - 5 * 60_000, now - 3 * 60_000],
      },
    };
    await writeFile(
      join(fakeHome, ".ashlr", "nudge-throttle.json"),
      JSON.stringify(state),
    );

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "needle", path: tmp } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const out = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(typeof out.additionalContext).toBe("string");
    const msg = out.additionalContext as string;
    expect(msg).toContain("[ashlr nudge]");
    // Escalation message mentions the count and suggests redirect.
    expect(msg).toContain("times in the last 10 minutes");
    expect(msg).toContain("set-hook-mode.ts redirect");
  });

  test("throttle: second Grep within 60s → no nudge emitted", async () => {
    const now = Date.now();
    // First call emitted a nudge just now.
    const state = {
      lastNudgeAt: now - 1000, // only 1s ago
      lastEscalationAt: 0,
      recentCalls: { Grep: [now - 1000] },
    };
    await writeFile(
      join(fakeHome, ".ashlr", "nudge-throttle.json"),
      JSON.stringify(state),
    );

    const { stdout, exitCode } = await runHook(
      NATIVE_NUDGE_HOOK,
      JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "needle", path: tmp } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
      tmp,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    // Should be empty / no additionalContext.
    const out = (parsed.hookSpecificOutput ?? parsed) as Record<string, unknown>;
    expect(out.additionalContext).toBeUndefined();
  });
});
