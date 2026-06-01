/**
 * track2-hooks.test.ts — Tests for Track 2 Claude feature parity hooks.
 *
 * Covers:
 *   - subagent-stop-rollup: rollup line builder
 *   - stop-accounting: idempotency guard (isAlreadyRecorded)
 *   - sessionstart-search/lean-tools/genome-author/cost-refactor/efficient:
 *       injects when enabled, silent when disabled
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ─── subagent-stop-rollup ─────────────────────────────────────────────────────

import { buildRollupLine } from "../hooks/subagent-stop-rollup";

describe("subagent-stop-rollup: buildRollupLine", () => {
  test("shapes a valid rollup line", () => {
    const line = buildRollupLine({
      taskId: "task-42",
      subagentSessionId: "sess-99",
      summary: { tokensSaved: 1000, calls: 12, topTool: "ashlr__bash" },
      ts: "2026-01-01T00:00:00.000Z",
    });
    expect(line.event).toBe("subagent_stop");
    expect(line.task_id).toBe("task-42");
    expect(line.subagent_session_id).toBe("sess-99");
    expect(line.tokens_saved).toBe(1000);
    expect(line.calls).toBe(12);
    expect(line.top_tool).toBe("ashlr__bash");
    expect(line.ts).toBe("2026-01-01T00:00:00.000Z");
  });

  test("accepts null task_id and subagent_session_id", () => {
    const line = buildRollupLine({
      taskId: null,
      subagentSessionId: null,
      summary: { tokensSaved: 0, calls: 0, topTool: null },
    });
    expect(line.task_id).toBeNull();
    expect(line.subagent_session_id).toBeNull();
  });

  test("uses current timestamp when ts not provided", () => {
    const before = Date.now();
    const line = buildRollupLine({ taskId: null, subagentSessionId: null, summary: { tokensSaved: 0, calls: 0, topTool: null } });
    const after = Date.now();
    const ts = new Date(line.ts).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─── stop-accounting ──────────────────────────────────────────────────────────

import { isAlreadyRecorded } from "../hooks/stop-accounting";

describe("stop-accounting: isAlreadyRecorded", () => {
  test("returns false when lines are empty", () => {
    expect(isAlreadyRecorded([], "sess-1")).toBe(false);
  });

  test("returns false when no matching session", () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "session_end",
      session: "other-session",
    });
    expect(isAlreadyRecorded([line], "sess-1")).toBe(false);
  });

  test("returns true for session_end within 60s", () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "session_end",
      session: "sess-1",
    });
    expect(isAlreadyRecorded([line], "sess-1")).toBe(true);
  });

  test("returns true for stop within 60s", () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "stop",
      session: "sess-1",
    });
    expect(isAlreadyRecorded([line], "sess-1")).toBe(true);
  });

  test("returns false for old entry (>60s ago)", () => {
    const oldTs = new Date(Date.now() - 90_000).toISOString();
    const line = JSON.stringify({ ts: oldTs, event: "stop", session: "sess-1" });
    expect(isAlreadyRecorded([line], "sess-1")).toBe(false);
  });

  test("returns false for non-terminal event within 60s", () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "tool_call",
      session: "sess-1",
    });
    expect(isAlreadyRecorded([line], "sess-1")).toBe(false);
  });

  test("handles malformed JSON lines gracefully", () => {
    expect(isAlreadyRecorded(["not json", "{bad}"], "sess-1")).toBe(false);
  });
});

// ─── sessionstart skill hooks ─────────────────────────────────────────────────

import { isEnabled as searchEnabled, buildAdditionalContext as searchCtx } from "../hooks/sessionstart-search";
import { isEnabled as leanEnabled, buildAdditionalContext as leanCtx } from "../hooks/sessionstart-lean-tools";
import { isEnabled as genomeAuthorEnabled, buildAdditionalContext as genomeAuthorCtx } from "../hooks/sessionstart-genome-author";
import { isEnabled as costRefactorEnabled, buildAdditionalContext as costRefactorCtx } from "../hooks/sessionstart-cost-refactor";
import { isEnabled as efficientEnabled, buildAdditionalContext as efficientCtx } from "../hooks/sessionstart-efficient";

function makeEnvDirs(): { homeDir: string; cwd: string; cleanup: () => void } {
  const homeDir = mkdtempSync(join(tmpdir(), "ashlr-skill-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ashlr-skill-cwd-"));
  writeFileSync(join(cwd, "package.json"), "{}");
  return {
    homeDir,
    cwd,
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const SKILL_CASES = [
  { name: "ashlr-search",        key: "search",        fn: searchEnabled,        ctxFn: searchCtx,        marker: "[ashlr-search]" },
  { name: "ashlr-lean-tools",    key: "lean-tools",    fn: leanEnabled,          ctxFn: leanCtx,          marker: "[ashlr-lean-tools]" },
  { name: "ashlr-genome-author", key: "genome-author", fn: genomeAuthorEnabled,  ctxFn: genomeAuthorCtx,  marker: "[ashlr-genome-author]" },
  { name: "ashlr-cost-refactor", key: "cost-refactor", fn: costRefactorEnabled,  ctxFn: costRefactorCtx,  marker: "[ashlr-cost-refactor]" },
] as const;

for (const { name, key, fn, ctxFn, marker } of SKILL_CASES) {
  describe(`sessionstart-${key}: isEnabled`, () => {
    test(`${name}: returns false when no config`, () => {
      const { homeDir, cwd, cleanup } = makeEnvDirs();
      expect(fn({ homeDir, cwd })).toBe(false);
      cleanup();
    });

    test(`${name}: returns true when user-level enabled`, () => {
      const { homeDir, cwd, cleanup } = makeEnvDirs();
      mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
      writeFileSync(join(homeDir, ".ashlr", `${key}.json`), JSON.stringify({ enabled: true }));
      expect(fn({ homeDir, cwd })).toBe(true);
      cleanup();
    });

    test(`${name}: returns false when user-level disabled`, () => {
      const { homeDir, cwd, cleanup } = makeEnvDirs();
      mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
      writeFileSync(join(homeDir, ".ashlr", `${key}.json`), JSON.stringify({ enabled: false }));
      expect(fn({ homeDir, cwd })).toBe(false);
      cleanup();
    });

    test(`${name}: project-level true overrides user-level false`, () => {
      const { homeDir, cwd, cleanup } = makeEnvDirs();
      mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
      writeFileSync(join(homeDir, ".ashlr", `${key}.json`), JSON.stringify({ enabled: false }));
      mkdirSync(join(cwd, ".ashlr"), { recursive: true });
      writeFileSync(join(cwd, ".ashlr", `${key}.json`), JSON.stringify({ enabled: true }));
      expect(fn({ homeDir, cwd })).toBe(true);
      cleanup();
    });

    test(`${name}: buildAdditionalContext includes marker`, () => {
      expect(ctxFn()).toContain(marker);
    });
  });
}

// Efficient hook: extra check for merged brief+efficient block
describe("sessionstart-efficient: isEnabled", () => {
  test("returns false when no config", () => {
    const { homeDir, cwd, cleanup } = makeEnvDirs();
    expect(efficientEnabled({ homeDir, cwd })).toBe(false);
    cleanup();
  });

  test("returns true when user-level enabled", () => {
    const { homeDir, cwd, cleanup } = makeEnvDirs();
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(join(homeDir, ".ashlr", "efficient.json"), JSON.stringify({ enabled: true }));
    expect(efficientEnabled({ homeDir, cwd })).toBe(true);
    cleanup();
  });
});

describe("sessionstart-efficient: buildAdditionalContext", () => {
  test("emits efficient-only block when brief is off", () => {
    const { homeDir, cwd, cleanup } = makeEnvDirs();
    // No brief.json → brief is off
    const ctx = efficientCtx({ homeDir, cwd });
    expect(ctx).toContain("[ashlr-efficient]");
    expect(ctx).not.toContain("ashlr-brief +");
    cleanup();
  });

  test("emits combined block when brief is also active", () => {
    const { homeDir, cwd, cleanup } = makeEnvDirs();
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(join(homeDir, ".ashlr", "brief.json"), JSON.stringify({ level: "standard" }));
    const ctx = efficientCtx({ homeDir, cwd });
    expect(ctx).toContain("ashlr-brief + ashlr-efficient");
    cleanup();
  });
});
