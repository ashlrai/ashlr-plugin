/**
 * Unit tests for the tool-redirect PreToolUse hook.
 *
 * Two layers:
 *   1. `decide()` — pure function tests for the routing logic.
 *   2. End-to-end — spawn the hook script with stdin/stdout to verify the
 *      shell contract Claude Code actually invokes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { decide, isRedirectEnabled } from "../hooks/tool-redirect.ts";

const HOOK_SCRIPT = join(import.meta.dir, "..", "hooks", "tool-redirect.ts");

async function runHook(stdin: string, env?: Record<string, string>): Promise<any> {
  const proc = spawn({
    cmd: ["bun", "run", HOOK_SCRIPT],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim() ? JSON.parse(out) : null;
}

describe("tool-redirect · decide()", () => {
  let tmp: string;
  let fakeHome: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-redir-"));
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-home-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("Read on a small file passes through silently", async () => {
    const path = join(tmp, "tiny.txt");
    await writeFile(path, "hello");
    const out = decide(
      { tool_name: "Read", tool_input: { file_path: path } },
      { home: fakeHome },
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("Read on a large (>2KB) file silently nudges toward ashlr__read", async () => {
    // Silent nudge contract: additionalContext is set so the agent learns
    // about ashlr__read, but permissionDecision is NEVER set — setting it
    // to "ask" would force a prompt even in bypassPermissions mode (Claude
    // Code docs: ask rules are evaluated regardless of mode).
    const path = join(tmp, "huge.txt");
    await writeFile(path, "x".repeat(5000));
    const out = decide(
      { tool_name: "Read", tool_input: { file_path: path } },
      { home: fakeHome },
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr__read");
    expect(out.hookSpecificOutput.additionalContext).toContain(path);
  });

  test("Read on a missing file passes through (no crash)", () => {
    const out = decide(
      { tool_name: "Read", tool_input: { file_path: "/nonexistent/zzz" } },
      { home: fakeHome },
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
  });

  test("Grep always nudges toward ashlr__grep", () => {
    const out = decide(
      { tool_name: "Grep", tool_input: { pattern: "foo.*bar" } },
      { home: fakeHome },
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr__grep");
    expect(out.hookSpecificOutput.additionalContext).toContain("foo.*bar");
  });

  test("Edit always nudges toward ashlr__edit", () => {
    const out = decide(
      { tool_name: "Edit", tool_input: { file_path: "/x/y.ts" } },
      { home: fakeHome },
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr__edit");
    expect(out.hookSpecificOutput.additionalContext).toContain("/x/y.ts");
  });

  test("unrelated tool names pass through", () => {
    const out = decide(
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { home: fakeHome },
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
  });

  test("opt-out via ~/.ashlr/settings.json forces pass-through", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: false }),
    );
    expect(isRedirectEnabled(fakeHome)).toBe(false);
    const out = decide(
      { tool_name: "Grep", tool_input: { pattern: "x" } },
      { home: fakeHome },
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("toolRedirect: true (or absent) keeps redirect enabled", async () => {
    expect(isRedirectEnabled(fakeHome)).toBe(true);
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: true }),
    );
    expect(isRedirectEnabled(fakeHome)).toBe(true);
  });

  test("malformed settings.json is treated as enabled (safe default)", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(join(fakeHome, ".ashlr", "settings.json"), "{not json");
    expect(isRedirectEnabled(fakeHome)).toBe(true);
  });
});

describe("tool-redirect · stdin/stdout end-to-end", () => {
  test("malformed JSON input → pass-through, no crash", async () => {
    const out = await runHook("this is not json at all }}}");
    expect(out).not.toBeNull();
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
  });

  test("empty stdin → pass-through", async () => {
    const out = await runHook("");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
  });

  test("Grep payload over stdin produces a nudge", async () => {
    const out = await runHook(
      JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "needle" } }),
    );
    expect((out.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr__grep");
  });
});
