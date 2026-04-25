/**
 * pretooluse-coverage.test.ts — end-to-end tests for the Glob, NotebookEdit,
 * and WebFetch PreToolUse hook wrappers added in v1.21.
 *
 * Covers:
 *   - Each hook passes through (exit 0, no permissionDecision) in redirect mode
 *   - Each hook emits a soft nudge in nudge mode
 *   - Each hook passes through silently in off mode
 *   - Timing records are written for each tool
 *   - Non-matching tool names pass through without a timing record for wrong hook
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const HOOK_GLOB = resolve(__dirname, "..", "hooks", "pretooluse-glob.ts");
const HOOK_NOTEBOOK = resolve(__dirname, "..", "hooks", "pretooluse-notebookedit.ts");
const HOOK_WEBFETCH = resolve(__dirname, "..", "hooks", "pretooluse-webfetch.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-coverage-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

async function runHook(
  script: string,
  payload: object,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; exitCode: number; timings: Array<Record<string, unknown>> }> {
  const proc = spawn({
    cmd: ["bun", "run", script],
    cwd: resolve(__dirname, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: (() => {
      // Strip env vars that would corrupt the test's "default redirect mode"
      // baseline. Tests opt-in to specific modes via extraEnv.
      const { ASHLR_HOOK_MODE: _hm, ASHLR_ENFORCE: _en, ...clean } = process.env;
      void _hm; void _en;
      return { ...clean, HOME: home, ...extraEnv };
    })(),
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const timingsRaw = await readFile(join(home, ".ashlr", "hook-timings.jsonl"), "utf-8").catch(() => "");
  const timings = timingsRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { stdout, exitCode, timings };
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------
describe("pretooluse-glob", () => {
  test("passes through silently in default redirect mode", async () => {
    const { stdout, exitCode } = await runHook(HOOK_GLOB, {
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("emits additionalContext in nudge mode", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK_GLOB,
      { tool_name: "Glob", tool_input: { pattern: "**/*.ts" } },
      { ASHLR_HOOK_MODE: "nudge" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__grep");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("passes through silently in off mode", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK_GLOB,
      { tool_name: "Glob", tool_input: { pattern: "*.json" } },
      { ASHLR_HOOK_MODE: "off" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("records timing entry for Glob tool", async () => {
    const { timings } = await runHook(HOOK_GLOB, {
      tool_name: "Glob",
      tool_input: { pattern: "*.ts" },
    });
    const record = timings.find((r) => r.hook === "pretooluse-glob");
    expect(record).toBeDefined();
    expect(record!.tool).toBe("Glob");
    expect(record!.outcome).toBe("ok");
  });

  test("exits 0 immediately for non-Glob tool names", async () => {
    const { exitCode, timings } = await runHook(HOOK_GLOB, {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x.ts" },
    });
    expect(exitCode).toBe(0);
    // Timing record is still written (with the non-Glob tool name)
    const record = timings.find((r) => r.hook === "pretooluse-glob");
    expect(record).toBeDefined();
    expect(record!.tool).toBe("Read");
  });
});

// ---------------------------------------------------------------------------
// NotebookEdit
// ---------------------------------------------------------------------------
describe("pretooluse-notebookedit", () => {
  test("passes through silently in default redirect mode", async () => {
    const { stdout, exitCode } = await runHook(HOOK_NOTEBOOK, {
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/tmp/nb.ipynb" },
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("emits additionalContext in nudge mode", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK_NOTEBOOK,
      { tool_name: "NotebookEdit", tool_input: { notebook_path: "/tmp/nb.ipynb" } },
      { ASHLR_HOOK_MODE: "nudge" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__edit_structural");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("passes through silently in off mode", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK_NOTEBOOK,
      { tool_name: "NotebookEdit", tool_input: {} },
      { ASHLR_HOOK_MODE: "off" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("records timing entry for NotebookEdit tool", async () => {
    const { timings } = await runHook(HOOK_NOTEBOOK, {
      tool_name: "NotebookEdit",
      tool_input: {},
    });
    const record = timings.find((r) => r.hook === "pretooluse-notebookedit");
    expect(record).toBeDefined();
    expect(record!.tool).toBe("NotebookEdit");
    expect(record!.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// WebFetch
// ---------------------------------------------------------------------------
describe("pretooluse-webfetch", () => {
  test("passes through silently in default redirect mode", async () => {
    const { stdout, exitCode } = await runHook(HOOK_WEBFETCH, {
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("emits additionalContext in nudge mode with the URL", async () => {
    const url = "https://docs.example.com/api";
    const { stdout, exitCode } = await runHook(
      HOOK_WEBFETCH,
      { tool_name: "WebFetch", tool_input: { url } },
      { ASHLR_HOOK_MODE: "nudge" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__webfetch");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(url);
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("passes through silently in off mode", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK_WEBFETCH,
      { tool_name: "WebFetch", tool_input: { url: "https://x.com" } },
      { ASHLR_HOOK_MODE: "off" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("records timing entry for WebFetch tool", async () => {
    const { timings } = await runHook(HOOK_WEBFETCH, {
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
    });
    const record = timings.find((r) => r.hook === "pretooluse-webfetch");
    expect(record).toBeDefined();
    expect(record!.tool).toBe("WebFetch");
    expect(record!.outcome).toBe("ok");
  });

  test("nudge with missing URL still produces a well-formed nudge", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK_WEBFETCH,
      { tool_name: "WebFetch", tool_input: {} },
      { ASHLR_HOOK_MODE: "nudge" },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__webfetch");
  });
});
