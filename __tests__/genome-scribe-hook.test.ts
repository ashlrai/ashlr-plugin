/**
 * Unit tests for hooks/genome-scribe-hook.ts
 *
 * Exercises decide() directly with injected home + cwd so the filesystem
 * side effects stay inside per-test tmpdirs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  decide,
  isEditTool,
  passThrough,
} from "../hooks/genome-scribe-hook";

let home: string;
let cwd: string;

function makeGenome(root: string): void {
  mkdirSync(join(root, ".ashlrcode", "genome"), { recursive: true });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-genome-hook-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ashlr-genome-hook-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("isEditTool", () => {
  test("recognizes Edit and ashlr__edit", () => {
    expect(isEditTool("Edit")).toBe(true);
    expect(isEditTool("ashlr__edit")).toBe(true);
    expect(isEditTool("mcp__plugin_ashlr_ashlr-edit__ashlr__edit")).toBe(true);
    expect(isEditTool("Read")).toBe(false);
    expect(isEditTool(undefined)).toBe(false);
  });
});

describe("genome-scribe-hook · decide", () => {
  test("substantial Edit (>20 LOC) with genome present → nudge fires", () => {
    makeGenome(cwd);
    const big = Array(30).fill("line").join("\n");
    const out = decide(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(cwd, "src/foo.ts"),
          old_string: "",
          new_string: big,
        },
      },
      { home, cwd },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr__genome_propose");
    expect(out.hookSpecificOutput.additionalContext).toContain("knowledge/decisions.md");
  });

  test("tiny Edit (3 LOC) with genome present → pass-through", () => {
    makeGenome(cwd);
    const small = "a\nb\nc";
    const out = decide(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(cwd, "src/foo.ts"),
          old_string: "x",
          new_string: small,
        },
      },
      { home, cwd },
    );
    expect(out).toEqual(passThrough());
  });

  test("tiny Edit touching an architectural path → nudge fires anyway", () => {
    makeGenome(cwd);
    const out = decide(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(cwd, "src/auth/session.ts"),
          old_string: "x",
          new_string: "y",
        },
      },
      { home, cwd },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("architectural");
  });

  test("no genome dir → pass-through", () => {
    const big = Array(30).fill("line").join("\n");
    const out = decide(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(cwd, "src/foo.ts"),
          old_string: "",
          new_string: big,
        },
      },
      { home, cwd },
    );
    expect(out).toEqual(passThrough());
  });

  test("non-edit tool passes through", () => {
    makeGenome(cwd);
    const out = decide(
      { tool_name: "Read", tool_input: { file_path: "/x" } },
      { home, cwd },
    );
    expect(out).toEqual(passThrough());
  });

  test("opt-out via settings.json → pass-through", () => {
    makeGenome(cwd);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "ashlr.genomeScribeAutoNudge": false }),
    );
    const big = Array(30).fill("line").join("\n");
    const out = decide(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(cwd, "src/foo.ts"),
          old_string: "",
          new_string: big,
        },
      },
      { home, cwd },
    );
    expect(out).toEqual(passThrough());
  });

  test("failed edit (isError) → pass-through", () => {
    makeGenome(cwd);
    const big = Array(30).fill("line").join("\n");
    const out = decide(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(cwd, "src/foo.ts"),
          old_string: "",
          new_string: big,
        },
        tool_response: { isError: true },
      },
      { home, cwd },
    );
    expect(out).toEqual(passThrough());
  });

  test("malformed / garbage payload → pass-through, no throw", () => {
    expect(decide({}, { home, cwd })).toEqual(passThrough());
    expect(
      decide(
        { tool_name: "Edit" } as never,
        { home, cwd },
      ),
    ).toEqual(passThrough());
    // Malformed tool_input shape — still no throw.
    expect(
      decide(
        {
          tool_name: "Edit",
          tool_input: { edits: "not-an-array" } as unknown as Record<string, unknown>,
        },
        { home, cwd },
      ),
    ).toEqual(passThrough());
  });

  test("multi-edit form accumulates LOC across hunks", () => {
    makeGenome(cwd);
    const hunk = Array(15).fill("x").join("\n");
    const out = decide(
      {
        tool_name: "ashlr__edit",
        tool_input: {
          file_path: join(cwd, "src/foo.ts"),
          edits: [
            { old_string: "a", new_string: hunk },
            { old_string: "b", new_string: hunk },
          ],
        },
      },
      { home, cwd },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
  });
});
