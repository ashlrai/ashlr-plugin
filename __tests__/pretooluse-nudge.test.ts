/**
 * Unit tests for the nudge + mode-resolution logic absorbed from the retired
 * hooks/tool-redirect.ts into hooks/pretooluse-common.ts.
 *
 * These tests cover:
 *   - `buildNudgeContext()` — the Read/Grep/Edit additionalContext builder.
 *   - `isRedirectEnabled()` — the `~/.ashlr/settings.json { toolRedirect }`
 *     kill switch.
 *   - `getHookMode()` priority chain: env > config.json > settings.json.
 *   - End-to-end: spawn pretooluse-read.ts with `ASHLR_HOOK_MODE=nudge` and
 *     verify the same additionalContext payload the old tool-redirect.ts hook
 *     emitted still reaches the agent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildNudgeContext,
  getHookMode,
  isRedirectEnabled,
} from "../hooks/pretooluse-common.ts";

const READ_HOOK = join(import.meta.dir, "..", "hooks", "pretooluse-read.ts");
const GREP_HOOK = join(import.meta.dir, "..", "hooks", "pretooluse-grep.ts");
const EDIT_HOOK = join(import.meta.dir, "..", "hooks", "pretooluse-edit.ts");

async function runHook(
  script: string,
  stdin: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", script],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

describe("buildNudgeContext — ported from tool-redirect.ts", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-nudge-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("Read on a small file returns null (pass-through)", async () => {
    const path = join(tmp, "tiny.txt");
    await writeFile(path, "hello");
    const out = buildNudgeContext("Read", { file_path: path });
    expect(out).toBeNull();
  });

  test("Read on a large (>2KB) file emits an additionalContext pointing at ashlr__read", async () => {
    const path = join(tmp, "huge.txt");
    await writeFile(path, "x".repeat(5000));
    const out = buildNudgeContext("Read", { file_path: path });
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out!.hookSpecificOutput.additionalContext).toContain("ashlr__read");
    expect(out!.hookSpecificOutput.additionalContext).toContain(path);
    // Silent-nudge contract: permissionDecision must not be set (would force
    // a user prompt even in bypassPermissions mode).
    expect(
      (out!.hookSpecificOutput as Record<string, unknown>).permissionDecision,
    ).toBeUndefined();
  });

  test("Read on a missing file returns null (safe pass-through)", () => {
    const out = buildNudgeContext("Read", {
      file_path: "/nonexistent/zzz-missing",
    });
    expect(out).toBeNull();
  });

  test("Grep always nudges toward ashlr__grep", () => {
    const out = buildNudgeContext("Grep", { pattern: "foo.*bar" });
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.additionalContext).toContain("ashlr__grep");
    expect(out!.hookSpecificOutput.additionalContext).toContain("foo.*bar");
  });

  test("Edit always nudges toward ashlr__edit", () => {
    const out = buildNudgeContext("Edit", { file_path: "/x/y.ts" });
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.additionalContext).toContain("ashlr__edit");
    expect(out!.hookSpecificOutput.additionalContext).toContain("/x/y.ts");
  });

  test("unrelated tool names return null", () => {
    const out = buildNudgeContext("Bash", { command: "ls" });
    expect(out).toBeNull();
  });
});

describe("isRedirectEnabled — ported from tool-redirect.ts", () => {
  let fakeHome: string;
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-home-"));
  });
  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("missing settings.json → enabled (default)", () => {
    expect(isRedirectEnabled(fakeHome)).toBe(true);
  });

  test("toolRedirect: false → disabled", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: false }),
    );
    expect(isRedirectEnabled(fakeHome)).toBe(false);
  });

  test("toolRedirect: true → enabled", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: true }),
    );
    expect(isRedirectEnabled(fakeHome)).toBe(true);
  });

  test("malformed settings.json → enabled (safe default)", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(join(fakeHome, ".ashlr", "settings.json"), "{not json");
    expect(isRedirectEnabled(fakeHome)).toBe(true);
  });
});

describe("getHookMode — priority chain", () => {
  let fakeHome: string;
  const envBackup = {
    mode: process.env.ASHLR_HOOK_MODE,
  };
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    delete process.env.ASHLR_HOOK_MODE;
  });
  afterEach(async () => {
    if (envBackup.mode === undefined) delete process.env.ASHLR_HOOK_MODE;
    else process.env.ASHLR_HOOK_MODE = envBackup.mode;
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("default is redirect when nothing is configured", () => {
    expect(getHookMode(fakeHome)).toBe("redirect");
  });

  test("ASHLR_HOOK_MODE env wins over everything else", async () => {
    // Write a config.json that says nudge AND a settings.json that says
    // toolRedirect:false — env var should still win.
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "config.json"),
      JSON.stringify({ hookMode: "nudge" }),
    );
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: false }),
    );
    process.env.ASHLR_HOOK_MODE = "redirect";
    expect(getHookMode(fakeHome)).toBe("redirect");
  });

  test("config.json hookMode wins over settings.json toolRedirect", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "config.json"),
      JSON.stringify({ hookMode: "redirect" }),
    );
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: false }),
    );
    expect(getHookMode(fakeHome)).toBe("redirect");
  });

  test("settings.json toolRedirect: false → resolves to off", async () => {
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: false }),
    );
    expect(getHookMode(fakeHome)).toBe("off");
  });

  test("ASHLR_HOOK_MODE=off is accepted", () => {
    process.env.ASHLR_HOOK_MODE = "off";
    expect(getHookMode(fakeHome)).toBe("off");
  });

  test("ASHLR_HOOK_MODE=nudge is accepted", () => {
    process.env.ASHLR_HOOK_MODE = "nudge";
    expect(getHookMode(fakeHome)).toBe("nudge");
  });

  test("invalid env values fall through to next layer", async () => {
    process.env.ASHLR_HOOK_MODE = "bogus";
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "config.json"),
      JSON.stringify({ hookMode: "nudge" }),
    );
    expect(getHookMode(fakeHome)).toBe("nudge");
  });
});

describe("end-to-end: pretooluse-*.ts in nudge mode emits tool-redirect-equivalent context", () => {
  let tmp: string;
  let fakeHome: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-e2e-"));
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-e2e-home-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("Read (>2KB) in nudge mode emits additionalContext with ashlr__read", async () => {
    const path = join(tmp, "big.txt");
    await writeFile(path, "x".repeat(5000));
    const { stdout, exitCode } = await runHook(
      READ_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "ashlr__read",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(path);
    expect(
      parsed.hookSpecificOutput.permissionDecision,
    ).toBeUndefined();
  });

  test("Grep in nudge mode emits additionalContext with ashlr__grep", async () => {
    const { stdout, exitCode } = await runHook(
      GREP_HOOK,
      JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "needle" } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "ashlr__grep",
    );
    expect(
      parsed.hookSpecificOutput.permissionDecision,
    ).toBeUndefined();
  });

  test("Edit in nudge mode emits additionalContext with ashlr__edit (even for small files)", async () => {
    // The retired tool-redirect.ts nudged Edit regardless of file size; the
    // absorbed logic preserves that behavior in nudge mode.
    const path = join(tmp, "small.ts");
    await writeFile(path, "export const x = 1;\n");
    const { stdout, exitCode } = await runHook(
      EDIT_HOOK,
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "ashlr__edit",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(path);
    expect(
      parsed.hookSpecificOutput.permissionDecision,
    ).toBeUndefined();
  });

  test("off mode (ASHLR_HOOK_MODE=off) is silent pass-through — no nudge", async () => {
    const path = join(tmp, "big.txt");
    await writeFile(path, "x".repeat(5000));
    const { stdout, exitCode } = await runHook(
      READ_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "off", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(
      parsed.hookSpecificOutput.additionalContext,
    ).toBeUndefined();
    expect(
      parsed.hookSpecificOutput.permissionDecision,
    ).toBeUndefined();
  });

  test("legacy ~/.ashlr/settings.json { toolRedirect: false } also → off (pass-through)", async () => {
    const path = join(tmp, "big.txt");
    await writeFile(path, "x".repeat(5000));
    await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(fakeHome, ".ashlr", "settings.json"),
      JSON.stringify({ toolRedirect: false }),
    );
    const { stdout, exitCode } = await runHook(
      READ_HOOK,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path } }),
      { HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(
      parsed.hookSpecificOutput.additionalContext,
    ).toBeUndefined();
    expect(
      parsed.hookSpecificOutput.permissionDecision,
    ).toBeUndefined();
  });
});
