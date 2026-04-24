/**
 * Tests for scripts/handoff-pack.ts
 *
 * All tests use isolated mkdtemp dirs; no real ~/.ashlr is touched.
 * readCurrentSession / readStats are not called in dryRun mode with
 * a synthetic sessionId, so stats.json is never read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { buildHandoffPack, findLastHandoff } from "../scripts/handoff-pack";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let home: string;
let logPath: string;
let outDir: string;

const NOW = new Date("2025-07-15T09:30:00Z").getTime();
const SESSION_ID = "test-session-abc123";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-handoff-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  logPath = join(home, ".ashlr", "session-log.jsonl");
  outDir = join(home, ".ashlr", "handoffs");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface FakeRecord {
  ts?: string;
  event?: string;
  tool?: string;
  cwd?: string;
  session?: string;
  input_size?: number;
  output_size?: number;
  input?: unknown;
}

function makeRecord(overrides: FakeRecord = {}): string {
  const base: FakeRecord = {
    ts: new Date(NOW - 60_000).toISOString(),
    event: "tool_call",
    tool: "ashlr__read",
    cwd: "/projects/myapp",
    session: SESSION_ID,
    input_size: 512,
    output_size: 1024,
  };
  return JSON.stringify({ ...base, ...overrides });
}

async function writeLog(records: string[]): Promise<void> {
  await writeFile(logPath, records.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Basic pack generation
// ---------------------------------------------------------------------------

describe("basic pack generation", () => {
  test("empty log → pack still generated with empty-section notes", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("# ashlr handoff");
    expect(result.content).toContain("## Session Summary");
    expect(result.content).toContain("## Recent Files Touched");
    expect(result.content).toContain("## Genome Status");
    expect(result.content).toContain("## Open Todos");
  });

  test("pack header contains ISO timestamp", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("2025-07-15");
  });

  test("pack path is inside outDir", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.path).toContain(outDir);
    expect(result.path).toMatch(/\.md$/);
  });

  test("path filename matches YYYY-MM-DD-HHMMSS-<rand>.md pattern", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
      randSuffix: "abc123",
    });
    // Use `basename` instead of splitting on "/", which returns the whole
    // path on Windows where separators are backslashes.
    const name = basename(result.path);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]+\.md$/);
    expect(name).toContain("abc123");
  });

  test("footer contains paste nudge with file path", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("Paste the contents of");
    expect(result.content).toContain(result.path);
  });
});

// ---------------------------------------------------------------------------
// Session summary section
// ---------------------------------------------------------------------------

describe("session summary section", () => {
  test("contains session ID", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: "my-unique-session-id",
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("my-unique-session-id");
  });

  test("gracefully handles missing stats (no stats.json)", async () => {
    // No stats.json in home — readCurrentSession may fail; should not throw
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("## Session Summary");
    // Should not throw — either shows data or graceful fallback message
    expect(result.content.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Recent files section
// ---------------------------------------------------------------------------

describe("recent files section", () => {
  test("empty session → no file ops note", async () => {
    // No records at all
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("## Recent Files Touched");
    expect(result.content).toContain("no file operations recorded");
  });

  test("read tool calls appear in section", async () => {
    const records = [
      makeRecord({ tool: "Read", cwd: "/projects/alpha", session: SESSION_ID }),
      makeRecord({ tool: "ashlr__read", cwd: "/projects/beta", session: SESSION_ID }),
      makeRecord({ tool: "Edit", cwd: "/projects/alpha", session: SESSION_ID }),
    ];
    await writeLog(records);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("## Recent Files Touched");
    // alpha appears 2x, beta 1x — both should be listed
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("beta");
  });

  test("non-file tools (Bash, Grep) excluded from file section", async () => {
    const records = [
      makeRecord({ tool: "Bash", cwd: "/projects/bash-only", session: SESSION_ID }),
      makeRecord({ tool: "Grep", cwd: "/projects/grep-only", session: SESSION_ID }),
    ];
    await writeLog(records);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("no file operations recorded");
  });

  test("only current session records used for file list", async () => {
    const records = [
      makeRecord({ tool: "Read", cwd: "/projects/mine", session: SESSION_ID }),
      makeRecord({ tool: "Read", cwd: "/projects/other", session: "other-session" }),
    ];
    await writeLog(records);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("mine");
    expect(result.content).not.toContain("other");
  });
});

// ---------------------------------------------------------------------------
// Genome status section
// ---------------------------------------------------------------------------

describe("genome status section", () => {
  test("no genome → prompts to run /ashlr-genome-init", async () => {
    // outDir is inside home which has no .ashlrcode/
    // But cwd is determined from log records. With empty log, cwd = process.cwd().
    // Force cwd via a record pointing to home (which has no genome).
    const records = [
      makeRecord({ tool: "Read", cwd: home, session: SESSION_ID }),
    ];
    await writeLog(records);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("## Genome Status");
    expect(result.content).toContain("/ashlr-genome-init");
  });

  test("genome manifest present → shows section count and updatedAt", async () => {
    const genomePath = join(home, ".ashlrcode", "genome");
    await mkdir(genomePath, { recursive: true });
    await writeFile(
      join(genomePath, "manifest.json"),
      JSON.stringify({
        sections: [{ id: "a" }, { id: "b" }, { id: "c" }],
        updatedAt: "2025-07-10T08:00:00Z",
      }),
    );
    const records = [makeRecord({ tool: "Read", cwd: home, session: SESSION_ID })];
    await writeLog(records);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("Sections: 3");
    expect(result.content).toContain("2025-07-10");
  });
});

// ---------------------------------------------------------------------------
// Open todos section
// ---------------------------------------------------------------------------

describe("open todos section", () => {
  test("no TodoWrite calls → no todos note", async () => {
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("## Open Todos");
    expect(result.content).toContain("no TodoWrite calls");
  });

  test("TodoWrite call with todos array → todos listed", async () => {
    const todos = {
      todos: [
        { content: "Write the tests", status: "in_progress", priority: "high" },
        { content: "Review PR", status: "pending", priority: "medium" },
      ],
    };
    const record = makeRecord({
      tool: "TodoWrite",
      session: SESSION_ID,
      input: todos,
    });
    await writeLog([record]);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("Write the tests");
    expect(result.content).toContain("Review PR");
    expect(result.content).toContain("in_progress");
    expect(result.content).toContain("[high]");
  });

  test("uses latest TodoWrite call (not first)", async () => {
    const first = makeRecord({
      tool: "TodoWrite",
      session: SESSION_ID,
      ts: new Date(NOW - 120_000).toISOString(),
      input: { todos: [{ content: "Old task", status: "pending" }] },
    });
    const latest = makeRecord({
      tool: "TodoWrite",
      session: SESSION_ID,
      ts: new Date(NOW - 10_000).toISOString(),
      input: { todos: [{ content: "New task", status: "in_progress" }] },
    });
    await writeLog([first, latest]);
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    expect(result.content).toContain("New task");
    expect(result.content).not.toContain("Old task");
  });
});

// ---------------------------------------------------------------------------
// Disk write (non-dryRun)
// ---------------------------------------------------------------------------

describe("disk write", () => {
  test("writes file to outDir when not dryRun", async () => {
    await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      randSuffix: "testwrite",
    });
    expect(existsSync(outDir)).toBe(true);
    const files = readdirSync(outDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("testwrite");
  });

  test("creates outDir if it does not exist", async () => {
    const deepDir = join(home, "deep", "nested", "handoffs");
    await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir: deepDir,
      now: NOW,
      randSuffix: "deepwrite",
    });
    expect(existsSync(deepDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --last: findLastHandoff
// ---------------------------------------------------------------------------

describe("findLastHandoff", () => {
  test("no handoffs yet → returns null", () => {
    expect(findLastHandoff(outDir)).toBeNull();
  });

  test("non-existent dir → returns null", () => {
    expect(findLastHandoff(join(home, "does-not-exist"))).toBeNull();
  });

  test("returns most recent handoff by filename sort", async () => {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "2025-07-10-100000-aaa.md"), "old");
    await writeFile(join(outDir, "2025-07-15-090000-bbb.md"), "new");
    await writeFile(join(outDir, "2025-07-12-120000-ccc.md"), "mid");
    const last = findLastHandoff(outDir);
    expect(last).toContain("2025-07-15");
  });

  test("ignores non-.md files", async () => {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "2025-07-15-090000-zzz.txt"), "not md");
    const last = findLastHandoff(outDir);
    expect(last).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-existent session id
// ---------------------------------------------------------------------------

describe("non-existent session id", () => {
  test("pack is generated with empty/fallback sections", async () => {
    // Log has records for a different session
    const records = [
      makeRecord({ session: "other-session", tool: "Read" }),
    ];
    await writeLog(records);
    const result = await buildHandoffPack({
      home,
      sessionId: "nonexistent-session-xyz",
      outDir,
      now: NOW,
      dryRun: true,
    });
    // Should still produce a pack — just with empty sections
    expect(result.content).toContain("# ashlr handoff");
    expect(result.content).toContain("nonexistent-session-xyz");
    expect(result.content).toContain("no file operations recorded");
    expect(result.content).toContain("no TodoWrite calls");
  });
});

// ---------------------------------------------------------------------------
// Timestamp collision: same second, different rand suffix
// ---------------------------------------------------------------------------

describe("timestamp collision avoidance", () => {
  test("two packs at same NOW get different filenames via rand suffix", async () => {
    const result1 = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
      // no randSuffix override → uses randomBytes
    });
    const result2 = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir,
      now: NOW,
      dryRun: true,
    });
    // Paths should differ because rand suffix is random
    expect(result1.path).not.toBe(result2.path);
  });

  test("explicit different rand suffixes produce different paths", async () => {
    const r1 = await buildHandoffPack({
      home, sessionId: SESSION_ID, outDir, now: NOW, dryRun: true, randSuffix: "aaa111",
    });
    const r2 = await buildHandoffPack({
      home, sessionId: SESSION_ID, outDir, now: NOW, dryRun: true, randSuffix: "bbb222",
    });
    expect(r1.path).not.toBe(r2.path);
    expect(r1.path).toContain("aaa111");
    expect(r2.path).toContain("bbb222");
  });
});

// ---------------------------------------------------------------------------
// --dir override
// ---------------------------------------------------------------------------

describe("--dir override", () => {
  test("custom outDir is respected", async () => {
    const customDir = join(home, "custom-handoffs");
    const result = await buildHandoffPack({
      home,
      sessionId: SESSION_ID,
      outDir: customDir,
      now: NOW,
      randSuffix: "custdir",
    });
    expect(result.path).toContain(customDir);
    expect(existsSync(customDir)).toBe(true);
  });
});
