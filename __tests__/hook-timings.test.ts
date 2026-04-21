/**
 * hook-timings.test.ts — v1.13 Phase 4.5: telemetry for PreToolUse hooks.
 *
 * Adds fire-and-forget recording of per-hook invocation duration to
 * `~/.ashlr/hook-timings.jsonl` so users on slow filesystems can diagnose
 * which hook is the culprit from real data. Covers:
 *
 *   - recordHookTiming appends a well-formed JSONL line.
 *   - ASHLR_HOOK_TIMINGS=0 disables the write (privacy/perf kill switch).
 *   - withHookTiming records duration + outcome for success and error paths.
 *   - End-to-end: spawning pretooluse-read.ts writes a timing record that
 *     correctly classifies bypass/block/ok outcomes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { recordHookTiming, withHookTiming } from "../hooks/pretooluse-common";

const HOOK_READ = resolve(__dirname, "..", "hooks", "pretooluse-read.ts");
const HOOK_GREP = resolve(__dirname, "..", "hooks", "pretooluse-grep.ts");
const HOOK_EDIT = resolve(__dirname, "..", "hooks", "pretooluse-edit.ts");
const HOOK_POLICY = resolve(__dirname, "..", "hooks", "policy-enforce.ts");
const HOOK_EMBEDDING = resolve(__dirname, "..", "hooks", "post-tool-use-embedding.ts");
const HOOK_GENOME = resolve(__dirname, "..", "hooks", "post-tool-use-genome.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-hook-timings-"));
  process.env.HOME = home;
  await mkdir(join(home, ".ashlr"), { recursive: true });
  delete process.env.ASHLR_HOOK_TIMINGS;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

async function readTimings(): Promise<Array<Record<string, unknown>>> {
  const path = join(home, ".ashlr", "hook-timings.jsonl");
  const raw = await readFile(path, "utf-8").catch(() => "");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("recordHookTiming", () => {
  test("appends one well-formed JSONL record", async () => {
    recordHookTiming({
      hook: "pretooluse-test",
      tool: "Read",
      durationMs: 42,
      outcome: "ok",
    });
    const rows = await readTimings();
    expect(rows.length).toBe(1);
    expect(rows[0]!.hook).toBe("pretooluse-test");
    expect(rows[0]!.tool).toBe("Read");
    expect(rows[0]!.durationMs).toBe(42);
    expect(rows[0]!.outcome).toBe("ok");
    expect(typeof rows[0]!.ts).toBe("string");
  });

  test("ASHLR_HOOK_TIMINGS=0 kills writes", async () => {
    process.env.ASHLR_HOOK_TIMINGS = "0";
    try {
      recordHookTiming({ hook: "h", durationMs: 10, outcome: "ok" });
      const rows = await readTimings();
      expect(rows.length).toBe(0);
    } finally {
      delete process.env.ASHLR_HOOK_TIMINGS;
    }
  });

  test("negative / fractional durationMs are normalized", async () => {
    recordHookTiming({ hook: "h", durationMs: -5, outcome: "ok" });
    recordHookTiming({ hook: "h", durationMs: 7.8, outcome: "ok" });
    const rows = await readTimings();
    expect(rows[0]!.durationMs).toBe(0);
    expect(rows[1]!.durationMs).toBe(8);
  });

  test("never throws on append failure — parent dir unwritable", async () => {
    // Point HOME at a path that doesn't exist and is outside tmp; mkdir -p
    // will succeed but the append must be silent if anything goes wrong.
    // The contract here is simpler: the function must not throw even in
    // the happy path when HOME has been deleted underneath it.
    await rm(home, { recursive: true, force: true });
    // No throw:
    expect(() =>
      recordHookTiming({ hook: "h", durationMs: 1, outcome: "ok" }),
    ).not.toThrow();
    // Re-create for afterEach cleanup.
    await mkdir(join(home, ".ashlr"), { recursive: true });
  });
});

describe("withHookTiming", () => {
  test("records duration + outcome for success", async () => {
    const out = await withHookTiming("hook-test", async () => {
      await Bun.sleep(5);
      return { value: 42, outcome: "bypass" as const, tool: "Grep" };
    });
    expect(out).toBe(42);
    const rows = await readTimings();
    expect(rows[0]!.hook).toBe("hook-test");
    expect(rows[0]!.outcome).toBe("bypass");
    expect(rows[0]!.tool).toBe("Grep");
    expect(Number(rows[0]!.durationMs)).toBeGreaterThanOrEqual(5);
  });

  test("records error outcome and re-throws", async () => {
    await expect(
      withHookTiming("hook-err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await readTimings();
    expect(rows[0]!.outcome).toBe("error");
    expect(rows[0]!.hook).toBe("hook-err");
  });
});

async function spawnHook(
  cmd: string,
  payload: object,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; rows: Array<Record<string, unknown>> }> {
  const proc = spawn({
    cmd: ["bun", "run", cmd],
    cwd: resolve(__dirname, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, ASHLR_ENFORCE: "1", ...extraEnv },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const exitCode = await proc.exited;
  const path = join(home, ".ashlr", "hook-timings.jsonl");
  const raw = await readFile(path, "utf-8").catch(() => "");
  const rows = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { exitCode, rows };
}

describe("pretooluse-read · end-to-end timing record", () => {
  test("records a bypass outcome when bypassSummary is set", async () => {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/whatever", bypassSummary: true },
    });
    const proc = spawn({
      cmd: ["bun", "run", HOOK_READ],
      cwd: resolve(__dirname, ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_ENFORCE: "1", // required to reach the bypass branch
      },
    });
    proc.stdin.write(payload);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const rows = await readTimings();
    expect(rows.length).toBe(1);
    expect(rows[0]!.hook).toBe("pretooluse-read");
    expect(rows[0]!.outcome).toBe("bypass");
    expect(rows[0]!.tool).toBe("Read");
  });

  test("records an ok outcome for non-Read calls", async () => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const proc = spawn({
      cmd: ["bun", "run", HOOK_READ],
      cwd: resolve(__dirname, ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, ASHLR_ENFORCE: "1" },
    });
    proc.stdin.write(payload);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const rows = await readTimings();
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.tool).toBe("Bash");
  });
});

describe("pretooluse-grep · end-to-end timing record", () => {
  test("records ok outcome for non-Grep tool", async () => {
    const { exitCode, rows } = await spawnHook(HOOK_GREP, {
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("pretooluse-grep");
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.tool).toBe("Bash");
  });

  test("records bypass outcome when bypassSummary is set", async () => {
    const { exitCode, rows } = await spawnHook(HOOK_GREP, {
      tool_name: "Grep",
      tool_input: { pattern: "foo", bypassSummary: true },
    });
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("pretooluse-grep");
    expect(rows[0]!.outcome).toBe("bypass");
  });

  test("records block outcome when Grep is intercepted", async () => {
    const { exitCode, rows } = await spawnHook(HOOK_GREP, {
      tool_name: "Grep",
      tool_input: { pattern: "foo", path: "/tmp" },
    });
    expect(exitCode).toBe(2);
    expect(rows[0]!.hook).toBe("pretooluse-grep");
    expect(rows[0]!.outcome).toBe("block");
  });
});

describe("pretooluse-edit · end-to-end timing record", () => {
  test("records ok outcome for non-Edit tool", async () => {
    const { exitCode, rows } = await spawnHook(HOOK_EDIT, {
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("pretooluse-edit");
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.tool).toBe("Bash");
  });

  test("records bypass outcome when bypassSummary is set", async () => {
    const { exitCode, rows } = await spawnHook(HOOK_EDIT, {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/test.ts", bypassSummary: true },
    });
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("pretooluse-edit");
    expect(rows[0]!.outcome).toBe("bypass");
  });

  test("records ok outcome for small file (under threshold)", async () => {
    // file_path doesn't exist → fileSize returns null → pass-through
    const { exitCode, rows } = await spawnHook(HOOK_EDIT, {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/nonexistent-ashlr-test-file.ts" },
    });
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("pretooluse-edit");
    expect(rows[0]!.outcome).toBe("ok");
  });
});

describe("policy-enforce · end-to-end timing record", () => {
  test("records ok outcome when no token set (disabled)", async () => {
    const { exitCode, rows } = await spawnHook(
      HOOK_POLICY,
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { ASHLR_PRO_TOKEN: "", ASHLR_POLICY_ENFORCE: "1" },
    );
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("policy-enforce");
    expect(rows[0]!.outcome).toBe("ok");
  });

  test("records ok outcome when ASHLR_POLICY_ENFORCE=0", async () => {
    const { exitCode, rows } = await spawnHook(
      HOOK_POLICY,
      { tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } },
      { ASHLR_PRO_TOKEN: "test-token", ASHLR_POLICY_ENFORCE: "0" },
    );
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("policy-enforce");
    expect(rows[0]!.outcome).toBe("ok");
  });
});

describe("post-tool-use-embedding · end-to-end timing record", () => {
  test("records ok outcome on normal invocation", async () => {
    const { exitCode, rows } = await spawnHook(
      HOOK_EMBEDDING,
      { tool_name: "ashlr__edit", tool_input: { path: "/tmp/nonexistent.ts" } },
      { ASHLR_CONTEXT_DB_DISABLE: "0" },
    );
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("post-tool-use-embedding");
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.tool).toBe("ashlr__edit");
  });

  test("records ok outcome when disabled via env var", async () => {
    const { exitCode, rows } = await spawnHook(
      HOOK_EMBEDDING,
      { tool_name: "ashlr__edit", tool_input: { path: "/tmp/x.ts" } },
      { ASHLR_CONTEXT_DB_DISABLE: "1" },
    );
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("post-tool-use-embedding");
    expect(rows[0]!.outcome).toBe("ok");
  });
});

describe("post-tool-use-genome · end-to-end timing record", () => {
  test("records ok outcome on normal invocation", async () => {
    const { exitCode, rows } = await spawnHook(
      HOOK_GENOME,
      { tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } },
    );
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("post-tool-use-genome");
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.tool).toBe("Edit");
  });

  test("records ok outcome when ASHLR_GENOME_AUTO=0", async () => {
    const { exitCode, rows } = await spawnHook(
      HOOK_GENOME,
      { tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } },
      { ASHLR_GENOME_AUTO: "0" },
    );
    expect(exitCode).toBe(0);
    expect(rows[0]!.hook).toBe("post-tool-use-genome");
    expect(rows[0]!.outcome).toBe("ok");
  });
});
