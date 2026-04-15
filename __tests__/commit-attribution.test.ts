/**
 * Unit tests for the commit-attribution PreToolUse hook.
 *
 * These exercise `processHookInput` directly with synthesized stdin payloads
 * so we don't depend on a real `~/.claude/settings.json`. A throwaway
 * settings file is written to a temp dir for the attribution-toggle test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { processHookInput, TRAILER, alreadyAttributed } from "../hooks/commit-attribution.ts";

let tmp: string;
let onSettings: string;
let offSettings: string;
let missingSettings: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ashlr-attr-"));
  onSettings = join(tmp, "on.json");
  offSettings = join(tmp, "off.json");
  missingSettings = join(tmp, "does-not-exist.json");
  writeFileSync(onSettings, JSON.stringify({ ashlr: { attribution: true } }));
  writeFileSync(offSettings, JSON.stringify({ ashlr: { attribution: false } }));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function bash(command: string): string {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command } });
}

function parse(out: string): any {
  return JSON.parse(out);
}

function rewritten(out: string): string | undefined {
  return parse(out)?.hookSpecificOutput?.updatedInput?.command;
}

describe("commit-attribution hook", () => {
  test("git commit -m double quotes → adds trailer", () => {
    const out = processHookInput(bash(`git commit -m "fix bug"`), onSettings);
    const cmd = rewritten(out);
    expect(cmd).toBeDefined();
    expect(cmd).toContain(TRAILER);
    expect(cmd!.startsWith(`git commit -m "fix bug`)).toBe(true);
    expect(cmd!.endsWith(`"`)).toBe(true);
  });

  test("git commit -m single quotes → adds trailer", () => {
    const out = processHookInput(bash(`git commit -m 'fix bug'`), onSettings);
    const cmd = rewritten(out);
    expect(cmd).toBeDefined();
    expect(cmd).toContain(TRAILER);
    expect(cmd!.startsWith(`git commit -m 'fix bug`)).toBe(true);
    expect(cmd!.endsWith(`'`)).toBe(true);
  });

  test(`git commit --message="..." → adds trailer`, () => {
    const out = processHookInput(bash(`git commit --message="ship it"`), onSettings);
    const cmd = rewritten(out);
    expect(cmd).toBeDefined();
    expect(cmd).toContain(TRAILER);
    expect(cmd).toContain(`--message="ship it`);
  });

  test("git commit -F msg.txt → pass-through (we don't touch files)", () => {
    const out = processHookInput(bash(`git commit -F msg.txt`), onSettings);
    expect(parse(out)).toEqual({});
  });

  test("bare git commit (editor) → pass-through", () => {
    const out = processHookInput(bash(`git commit`), onSettings);
    expect(parse(out)).toEqual({});
  });

  test("message already contains Co-Authored-By → pass-through", () => {
    const out = processHookInput(
      bash(`git commit -m "fix\n\nCo-Authored-By: Someone <x@y>"`),
      onSettings,
    );
    expect(parse(out)).toEqual({});
  });

  test("message already contains Assisted-By → pass-through", () => {
    const out = processHookInput(
      bash(`git commit -m "fix\n\nAssisted-By: ashlr-plugin"`),
      onSettings,
    );
    expect(parse(out)).toEqual({});
  });

  test("attribution=false → pass-through", () => {
    const out = processHookInput(bash(`git commit -m "fix"`), offSettings);
    expect(parse(out)).toEqual({});
  });

  test("missing settings file → defaults to attribution ON", () => {
    const out = processHookInput(bash(`git commit -m "fix"`), missingSettings);
    expect(rewritten(out)).toContain(TRAILER);
  });

  test("non-git Bash command → pass-through", () => {
    const out = processHookInput(bash(`ls -la`), onSettings);
    expect(parse(out)).toEqual({});
  });

  test("malformed JSON → pass-through", () => {
    const out = processHookInput("{not json", onSettings);
    expect(parse(out)).toEqual({});
  });

  test("non-Bash tool → pass-through", () => {
    const out = processHookInput(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
      onSettings,
    );
    expect(parse(out)).toEqual({});
  });

  test("alreadyAttributed helper recognizes both trailers", () => {
    expect(alreadyAttributed("body\n\nCo-Authored-By: x")).toBe(true);
    expect(alreadyAttributed("body\n\nAssisted-By: ashlr-plugin")).toBe(true);
    expect(alreadyAttributed("just a plain message")).toBe(false);
  });

  test("git commit -am \"...\" (combined flags) → adds trailer", () => {
    const out = processHookInput(bash(`git commit -am "wip"`), onSettings);
    // -am is technically `-a -m`; our regex matches `-m ` so this shape with
    // bundled flags won't match. Document the behavior explicitly:
    // we pass through rather than mis-parse.
    // (If a future change adds support, this expectation should flip.)
    expect(parse(out)).toEqual({});
  });
});
