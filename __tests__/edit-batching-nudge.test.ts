/**
 * Unit tests for hooks/edit-batching-nudge.ts
 *
 * Exercises decide() directly (not the stdio main loop) so we can inject
 * deterministic clock + pid + HOME values.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  decide,
  loadState,
  NUDGE_THRESHOLD,
  passThrough,
  statePath,
  WINDOW_MS,
} from "../hooks/edit-batching-nudge";

let home: string;
const PID = 99999;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-edit-batch-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("edit-batching-nudge", () => {
  test("first edit does not nudge", () => {
    const out = decide(
      { tool_name: "Edit", tool_input: { file_path: "/x" } },
      { home, pid: PID, now: 1_000 },
    );
    expect(out).toEqual(passThrough());
    const state = loadState(statePath(home), PID);
    expect(state.timestamps.length).toBe(1);
  });

  test("4th edit within 60s emits a nudge", () => {
    const base = 10_000;
    for (let i = 0; i < NUDGE_THRESHOLD; i++) {
      const out = decide(
        { tool_name: "Edit" },
        { home, pid: PID, now: base + i * 1000 },
      );
      expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
    }
    const fourth = decide(
      { tool_name: "Edit" },
      { home, pid: PID, now: base + NUDGE_THRESHOLD * 1000 },
    );
    expect(fourth.hookSpecificOutput.additionalContext).toBeDefined();
    expect(fourth.hookSpecificOutput.additionalContext).toContain("4");
    expect(fourth.hookSpecificOutput.additionalContext).toContain("ashlr");
  });

  test("ashlr__edit also counts toward the threshold", () => {
    const base = 50_000;
    for (let i = 0; i < NUDGE_THRESHOLD; i++) {
      decide({ tool_name: "ashlr__edit" }, { home, pid: PID, now: base + i * 100 });
    }
    const out = decide(
      { tool_name: "ashlr__edit" },
      { home, pid: PID, now: base + NUDGE_THRESHOLD * 100 },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeDefined();
  });

  test("nudge resets after the rolling window expires", () => {
    const base = 100_000;
    // Fire 4 edits so a nudge would trigger.
    for (let i = 0; i < NUDGE_THRESHOLD + 1; i++) {
      decide({ tool_name: "Edit" }, { home, pid: PID, now: base + i * 1000 });
    }
    // Jump past the window. Old timestamps fall off, this new one is alone.
    const after = decide(
      { tool_name: "Edit" },
      { home, pid: PID, now: base + WINDOW_MS + 60_000 },
    );
    expect(after.hookSpecificOutput.additionalContext).toBeUndefined();
    const state = loadState(statePath(home), PID);
    expect(state.timestamps.length).toBe(1);
  });

  test("session reset on new PID clears prior counts", () => {
    const base = 200_000;
    for (let i = 0; i < NUDGE_THRESHOLD + 2; i++) {
      decide({ tool_name: "Edit" }, { home, pid: PID, now: base + i * 100 });
    }
    // New PID = new session.
    const out = decide(
      { tool_name: "Edit" },
      { home, pid: PID + 1, now: base + 5_000 },
    );
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
    const state = loadState(statePath(home), PID + 1);
    expect(state.timestamps.length).toBe(1);
  });

  test("non-edit tool calls pass through silently", () => {
    const out = decide(
      { tool_name: "Read", tool_input: { file_path: "/x" } },
      { home, pid: PID, now: 1_000 },
    );
    expect(out).toEqual(passThrough());
  });

  test("malformed payload (missing tool_name) passes through", () => {
    expect(decide({}, { home, pid: PID, now: 1 })).toEqual(passThrough());
    expect(
      decide({ tool_name: undefined as unknown as string }, { home, pid: PID, now: 1 }),
    ).toEqual(passThrough());
    // Garbage object shape — still no throw, still pass-through.
    expect(
      decide(
        { tool_name: "Bash", tool_input: { foo: "bar" } } as never,
        { home, pid: PID, now: 1 },
      ),
    ).toEqual(passThrough());
  });
});
