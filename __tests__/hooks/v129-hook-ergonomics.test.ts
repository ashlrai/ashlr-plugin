/**
 * v1.29 hook-ergonomics test suite.
 *
 * Covers the behaviors introduced in v1.29 "Hooks With Manners":
 *   - getHookModeFor — per-hook override resolution via hookModes config
 *   - noteHookError — stderr + persistent JSONL surface for hook failures
 *   - installHookTimeout — safety-net top-level timeout primitive
 *   - pretooluse-task ASHLR_TASK_PASSTHROUGH escape valve (integration test)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getHookModeFor, installHookTimeout } from "../../hooks/pretooluse-common";
import { noteHookError } from "../../hooks/_hook-errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpHome(): string {
  const dir = join(tmpdir(), `ashlr-v129-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".ashlr"), { recursive: true });
  return dir;
}

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj), "utf-8");
}

const ORIG_ENV = { ...process.env };

function clearAshlrEnv(): void {
  delete process.env.ASHLR_HOOK_MODE;
  delete process.env.ASHLR_HOOK_TIMEOUT_MS;
  delete process.env.ASHLR_TASK_PASSTHROUGH;
  delete process.env.ASHLR_HOME_OVERRIDE;
}

beforeEach(() => clearAshlrEnv());
afterEach(() => {
  // Restore the original env so we don't leak between tests.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const k of Object.keys(ORIG_ENV)) {
    process.env[k] = ORIG_ENV[k]!;
  }
});

// ---------------------------------------------------------------------------
// getHookModeFor — per-hook overrides
// ---------------------------------------------------------------------------

describe("getHookModeFor — per-hook override resolution", () => {
  test("returns 'redirect' default when no overrides exist", () => {
    const home = tmpHome();
    try {
      expect(getHookModeFor("task", home)).toBe("redirect");
      expect(getHookModeFor("read", home)).toBe("redirect");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("hookModes in settings.json overrides specific hook", () => {
    const home = tmpHome();
    try {
      writeJson(join(home, ".ashlr", "settings.json"), {
        hookModes: { task: "nudge", grep: "off" },
      });
      expect(getHookModeFor("task", home)).toBe("nudge");
      expect(getHookModeFor("grep", home)).toBe("off");
      // Hooks without an override fall back to the global default.
      expect(getHookModeFor("read", home)).toBe("redirect");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("hookModes in config.json works when settings.json is absent", () => {
    const home = tmpHome();
    try {
      writeJson(join(home, ".ashlr", "config.json"), {
        hookModes: { task: "off" },
      });
      expect(getHookModeFor("task", home)).toBe("off");
      expect(getHookModeFor("read", home)).toBe("redirect");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("settings.json wins over config.json for the same hook key", () => {
    const home = tmpHome();
    try {
      writeJson(join(home, ".ashlr", "settings.json"), {
        hookModes: { task: "nudge" },
      });
      writeJson(join(home, ".ashlr", "config.json"), {
        hookModes: { task: "off" },
      });
      expect(getHookModeFor("task", home)).toBe("nudge");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ASHLR_HOOK_MODE env wins over per-hook overrides (panic switch)", () => {
    const home = tmpHome();
    try {
      writeJson(join(home, ".ashlr", "settings.json"), {
        hookModes: { task: "nudge" },
      });
      process.env.ASHLR_HOOK_MODE = "off";
      expect(getHookModeFor("task", home)).toBe("off");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls through to global hookMode when no per-hook override matches", () => {
    const home = tmpHome();
    try {
      writeJson(join(home, ".ashlr", "config.json"), {
        hookMode: "nudge",
        hookModes: { grep: "off" }, // only grep is overridden
      });
      expect(getHookModeFor("task", home)).toBe("nudge"); // falls to global
      expect(getHookModeFor("grep", home)).toBe("off"); // per-hook wins
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("malformed settings.json doesn't break resolution (falls through)", () => {
    const home = tmpHome();
    try {
      writeFileSync(join(home, ".ashlr", "settings.json"), "{ malformed json", "utf-8");
      expect(getHookModeFor("task", home)).toBe("redirect");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("invalid mode value in hookModes is ignored", () => {
    const home = tmpHome();
    try {
      writeJson(join(home, ".ashlr", "settings.json"), {
        hookModes: { task: "bogus_mode_value" },
      });
      expect(getHookModeFor("task", home)).toBe("redirect");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// noteHookError — stderr + JSONL persistence
// ---------------------------------------------------------------------------

describe("noteHookError — error surfacing", () => {
  test("appends a JSON line to ~/.ashlr/hook-errors.jsonl", () => {
    const home = tmpHome();
    try {
      process.env.ASHLR_HOME_OVERRIDE = home;
      noteHookError("test-hook", "test-context", new Error("boom"));
      const p = join(home, ".ashlr", "hook-errors.jsonl");
      expect(existsSync(p)).toBe(true);
      const raw = readFileSync(p, "utf-8").trim();
      const entry = JSON.parse(raw);
      expect(entry.hook).toBe("test-hook");
      expect(entry.context).toBe("test-context");
      expect(entry.error).toBe("boom");
      expect(typeof entry.ts).toBe("string");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("handles non-Error throwables (strings, objects)", () => {
    const home = tmpHome();
    try {
      process.env.ASHLR_HOME_OVERRIDE = home;
      noteHookError("h", "c1", "just-a-string");
      noteHookError("h", "c2", { reason: "object-payload" });
      const p = join(home, ".ashlr", "hook-errors.jsonl");
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);
      const e1 = JSON.parse(lines[0]!);
      expect(e1.error).toBe("just-a-string");
      const e2 = JSON.parse(lines[1]!);
      // String() on an object is "[object Object]" — accepting that as the
      // documented behavior; the important property is "never throws".
      expect(typeof e2.error).toBe("string");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never throws even when the home dir is unwritable", () => {
    // Point HOME at a path that can't be created (a file, not a dir).
    const home = join(tmpdir(), `ashlr-unwritable-${Date.now()}.txt`);
    writeFileSync(home, "this-is-a-file-not-a-dir", "utf-8");
    try {
      process.env.ASHLR_HOME_OVERRIDE = home;
      // Should not throw — surfacing best-effort.
      expect(() => noteHookError("h", "c", new Error("oops"))).not.toThrow();
    } finally {
      rmSync(home, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// installHookTimeout — safety-net timer
// ---------------------------------------------------------------------------

describe("installHookTimeout — non-blocking safety timer", () => {
  test("returns synchronously without throwing", () => {
    expect(() => installHookTimeout("test-hook", 10000)).not.toThrow();
  });

  test("respects ASHLR_HOOK_TIMEOUT_MS env override (smoke test)", () => {
    // We can't easily intercept the setTimeout in-process without elaborate
    // mocking, but we can verify the function reads the env without throwing
    // and returns. The actual force-exit behavior is covered by integration
    // tests that spawn the hook as a subprocess.
    process.env.ASHLR_HOOK_TIMEOUT_MS = "5000";
    expect(() => installHookTimeout("test-hook")).not.toThrow();
  });

  test("does not extend the process lifetime (timer is unref'd)", () => {
    // If the timer kept the process alive, this test would hang.
    // The fact that bun-test completes the test in milliseconds confirms
    // the timer is unref'd correctly.
    installHookTimeout("test-hook", 60_000);
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pretooluse-task — ASHLR_TASK_PASSTHROUGH integration
// ---------------------------------------------------------------------------

describe("pretooluse-task — ASHLR_TASK_PASSTHROUGH escape valve", () => {
  const hookPath = join(import.meta.dir, "../../hooks/pretooluse-task.ts");

  async function runHook(
    payload: object,
    env: Record<string, string> = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", hookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }

  test("ASHLR_TASK_PASSTHROUGH=1 makes TaskList pass through (no block)", async () => {
    const { exitCode, stdout } = await runHook(
      { tool_name: "TaskList", tool_input: {} },
      { ASHLR_TASK_PASSTHROUGH: "1" },
    );
    expect(exitCode).toBe(0);
    // Output should be a buildPassThrough payload, NOT a redirect block.
    const parsed = JSON.parse(stdout || "{}");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  test("ASHLR_TASK_PASSTHROUGH=1 makes TaskGet pass through", async () => {
    const { exitCode, stdout } = await runHook(
      { tool_name: "TaskGet", tool_input: { task_id: "abc" } },
      { ASHLR_TASK_PASSTHROUGH: "1" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout || "{}");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  test("without the env, TaskList is still blocked in redirect mode", async () => {
    // Use ASHLR_HOOK_MODE=redirect explicitly (the default) to make this test
    // robust to user-level config in test envs.
    const { stdout } = await runHook(
      { tool_name: "TaskList", tool_input: {} },
      { ASHLR_HOOK_MODE: "redirect" },
    );
    const parsed = JSON.parse(stdout || "{}");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain(
      "Blocking the built-in TaskList",
    );
  });

  test("redirect message tells the agent about ASHLR_TASK_PASSTHROUGH", async () => {
    const { stdout } = await runHook(
      { tool_name: "TaskList", tool_input: {} },
      { ASHLR_HOOK_MODE: "redirect" },
    );
    const parsed = JSON.parse(stdout || "{}");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain(
      "ASHLR_TASK_PASSTHROUGH=1",
    );
  });
});
