/**
 * track2-hooks.test.ts — Tests for Track 2 Claude feature parity hooks.
 *
 * Covers:
 *   - subagent-stop-rollup: rollup line builder, idempotent append + dedupe
 *   - stop-accounting: idempotency guard (isAlreadyRecorded)
 *   - sessionstart-search/lean-tools/genome-author/cost-refactor/efficient:
 *       injects when enabled, silent when disabled
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const ROOT = resolve(__dirname, "..");

// ─── subagent-stop-rollup ─────────────────────────────────────────────────────

import {
  appendRollupLine,
  buildRollupLine,
  dedupeSubagentStopLines,
  subagentStopKey,
} from "../hooks/subagent-stop-rollup";

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

describe("subagent-stop-rollup: subagentStopKey", () => {
  test("prefers task_id, falls back to agent_id then subagent_session_id", () => {
    expect(subagentStopKey({ task_id: "t1", agent_id: "a1", subagent_session_id: "s1" })).toBe("t1");
    expect(subagentStopKey({ task_id: null, agent_id: "a1", subagent_session_id: "s1" })).toBe("a1");
    expect(subagentStopKey({ task_id: null, agent_id: null, subagent_session_id: "s1" })).toBe("s1");
  });

  test("returns null when no identifier is usable", () => {
    expect(subagentStopKey({ task_id: null, agent_id: null, subagent_session_id: null })).toBeNull();
    expect(subagentStopKey({})).toBeNull();
    expect(subagentStopKey({ task_id: "", agent_id: 42 })).toBeNull();
  });
});

describe("subagent-stop-rollup: dedupeSubagentStopLines", () => {
  const stop = (task_id: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      event: "subagent_stop",
      task_id,
      subagent_session_id: "sess",
      tokens_saved: 0,
      calls: 0,
      top_tool: null,
      ...extra,
    });

  test("keeps the first occurrence per task_id, drops repeats", () => {
    const lines = [stop("t1"), stop("t2"), stop("t1")];
    expect(dedupeSubagentStopLines(lines)).toEqual([lines[0], lines[1]]);
  });

  test("dedupes across task_id and agent_id for the same id", () => {
    const claude = stop("agent-9");
    const codex = stop(null, { agent_id: "agent-9", task_id: null });
    expect(dedupeSubagentStopLines([claude, codex])).toEqual([claude]);
  });

  test("preserves other events and malformed lines verbatim", () => {
    const tool = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "tool_call", tool: "x" });
    const lines = [stop("t1"), "not json", tool, stop("t1")];
    expect(dedupeSubagentStopLines(lines)).toEqual([lines[0], "not json", tool]);
  });

  test("subagent_stop lines without any identifier are never deduped", () => {
    const keyless = stop(null, { subagent_session_id: null });
    expect(dedupeSubagentStopLines([keyless, keyless])).toHaveLength(2);
  });
});

describe("subagent-stop-rollup: appendRollupLine", () => {
  function tmpLog(): { logPath: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "ashlr-rollup-"));
    return {
      logPath: join(dir, ".ashlr", "session-log.jsonl"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  const line = (taskId: string | null) =>
    buildRollupLine({
      taskId,
      subagentSessionId: "sess-1",
      summary: { tokensSaved: 1, calls: 1, topTool: null },
      ts: "2026-01-01T00:00:00.000Z",
    });
  const readLines = (p: string) =>
    readFileSync(p, "utf-8").split("\n").filter((l) => l.trim().length > 0);

  test("a repeated stop writes one line", async () => {
    const { logPath, cleanup } = tmpLog();
    try {
      const first = await appendRollupLine(logPath, line("t-1"));
      const other = await appendRollupLine(logPath, line("t-2"));
      const repeat = await appendRollupLine(logPath, line("t-1"));

      expect(first.appended).toBe(true);
      expect(other.appended).toBe(true);
      expect(repeat.appended).toBe(false);
      expect(repeat.removed).toBe(0);

      const taskIds = readLines(logPath).map(
        (l) => (JSON.parse(l) as { task_id: string }).task_id,
      );
      expect(taskIds).toEqual(["t-1", "t-2"]);
    } finally {
      cleanup();
    }
  });

  test("collapses pre-existing duplicate subagent_stop lines in the log", async () => {
    const { logPath, cleanup } = tmpLog();
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const dup = JSON.stringify(line("t-1"));
      const tool = JSON.stringify({ event: "tool_call", tool: "x" });
      writeFileSync(logPath, `${dup}\n${tool}\n${dup}\n`);

      const res = await appendRollupLine(logPath, line("t-9"));
      expect(res.appended).toBe(true);
      expect(res.removed).toBe(1);

      const lines = readLines(logPath);
      expect(lines).toHaveLength(3);
      const t1 = lines.filter((l) => {
        const p = JSON.parse(l) as { event: string; task_id: string };
        return p.event === "subagent_stop" && p.task_id === "t-1";
      });
      expect(t1).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("repeated stop repairs existing dupes without appending", async () => {
    const { logPath, cleanup } = tmpLog();
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const dup = JSON.stringify(line("t-1"));
      writeFileSync(logPath, `${dup}\n${dup}\n`);

      const res = await appendRollupLine(logPath, line("t-1"));
      expect(res.appended).toBe(false);
      expect(res.removed).toBe(1);
      expect(readLines(logPath)).toEqual([dup]);
    } finally {
      cleanup();
    }
  });

  test("stops without any identifier still append", async () => {
    const { logPath, cleanup } = tmpLog();
    try {
      const l = buildRollupLine({
        taskId: null,
        subagentSessionId: null,
        summary: { tokensSaved: 0, calls: 0, topTool: null },
      });
      const r1 = await appendRollupLine(logPath, l);
      const r2 = await appendRollupLine(logPath, l);
      expect(r1.appended).toBe(true);
      expect(r2.appended).toBe(true);
      expect(readLines(logPath)).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("hook subprocess: two identical stops write one session-log line", async () => {
    const home = mkdtempSync(join(tmpdir(), "ashlr-rollup-e2e-home-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "ashlr-rollup-e2e-plugin-"));
    try {
      const payload = JSON.stringify({ task_id: "task-e2e", subagent_session_id: "sess-e2e" });
      const runOnce = async () => {
        const proc = spawn({
          cmd: ["bun", "run", "hooks/subagent-stop-rollup.ts"],
          cwd: ROOT,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: home,
            CLAUDE_PLUGIN_ROOT: pluginRoot,
            ASHLR_SESSION_LOG: "1",
            ASHLR_GENOME_AUTO: "0",
          },
        });
        proc.stdin.write(payload);
        await proc.stdin.end();
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      };

      const first = await runOnce();
      const second = await runOnce();
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.stdout).toBe("");
      expect(second.stdout).toBe("");
      expect(first.stderr).toBe("");
      expect(second.stderr).toBe("");

      const stops = readLines(join(home, ".ashlr", "session-log.jsonl")).filter((l) => {
        try {
          return (JSON.parse(l) as { event: string }).event === "subagent_stop";
        } catch {
          return false;
        }
      });
      expect(stops).toHaveLength(1);
      expect((JSON.parse(stops[0]) as { task_id: string }).task_id).toBe("task-e2e");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
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
