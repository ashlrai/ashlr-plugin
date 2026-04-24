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
  cwd?: string,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", script],
    cwd,
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

  test("Write on an existing file nudges toward ashlr__edit", async () => {
    const path = join(tmp, "rewrite.ts");
    await writeFile(path, "export const x = 1;\n");
    const out = buildNudgeContext("Write", { file_path: path });
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.additionalContext).toContain("ashlr__edit");
    expect(out!.hookSpecificOutput.additionalContext).toContain(path);
  });

  test("Write on a non-existent file returns null (new-file creation has no equivalent)", () => {
    const out = buildNudgeContext("Write", {
      file_path: "/nonexistent/zzz-newfile.ts",
    });
    expect(out).toBeNull();
  });

  test("MultiEdit always nudges toward ashlr__multi_edit", () => {
    const out = buildNudgeContext("MultiEdit", { file_path: "/x/y.ts" });
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.additionalContext).toContain("ashlr__multi_edit");
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

  test("Write (existing file) in nudge mode emits ashlr__edit suggestion", async () => {
    const path = join(tmp, "existing.ts");
    await writeFile(path, "export const x = 1;\n");
    const { stdout, exitCode } = await runHook(
      EDIT_HOOK,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "ashlr__edit",
    );
  });

  test("Write (new file) in nudge mode passes through silently — no nudge", async () => {
    // New-file creation has no ashlr equivalent; the hook must not refuse
    // or nudge, otherwise the agent has no recoverable path.
    const path = join(tmp, "brand-new.ts");
    const { stdout, exitCode } = await runHook(
      EDIT_HOOK,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(
      parsed.hookSpecificOutput.additionalContext,
    ).toBeUndefined();
  });

  test("MultiEdit in nudge mode emits ashlr__multi_edit suggestion", async () => {
    const path = join(tmp, "multi.ts");
    await writeFile(path, "export const x = 1;\n");
    const { stdout, exitCode } = await runHook(
      EDIT_HOOK,
      JSON.stringify({
        tool_name: "MultiEdit",
        tool_input: { file_path: path, edits: [{ old_string: "1", new_string: "2" }] },
      }),
      { ASHLR_HOOK_MODE: "nudge", HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "ashlr__multi_edit",
    );
  });

  test("Write (large existing file inside cwd) in redirect mode blocks toward ashlr__edit", async () => {
    const path = join(tmp, "big-rewrite.ts");
    await writeFile(path, "x".repeat(8000)); // > 5KB threshold
    // Set spawned hook's cwd to `tmp` so the file lies inside cwd — otherwise
    // the hook falls back to nudge per the "out-of-scope" safety net.
    const { stdout, exitCode } = await runHook(
      EDIT_HOOK,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } }),
      { HOME: fakeHome }, // default redirect mode
      tmp,
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      "ashlr__edit",
    );
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      "Write",
    );
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
