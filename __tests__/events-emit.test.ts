/**
 * Tests for servers/_events.ts — logEvent direct unit tests.
 *
 * All tests use an isolated tmp dir as $HOME; the real ~/.ashlr is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let home: string;
let logPath: string;
let origHome: string | undefined;
let origSessionLog: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-events-test-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  logPath = join(home, ".ashlr", "session-log.jsonl");

  origHome = process.env.HOME;
  origSessionLog = process.env.ASHLR_SESSION_LOG;
  process.env.HOME = home;
  delete process.env.ASHLR_SESSION_LOG;
});

afterEach(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origSessionLog !== undefined) process.env.ASHLR_SESSION_LOG = origSessionLog;
  else delete process.env.ASHLR_SESSION_LOG;
  await rm(home, { recursive: true, force: true });
});

async function readLog(): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(logPath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// Re-import after env is set. Because Bun caches modules, we import once at
// module level and rely on the logPath() function inside _events.ts reading
// process.env.HOME at call-time (which it does).
import { logEvent } from "../servers/_events";

// ---------------------------------------------------------------------------
// Schema compliance
// ---------------------------------------------------------------------------

describe("schema compliance", () => {
  test("writes a valid JSONL record with required fields", async () => {
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
    const records = await readLog();
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(typeof r.ts).toBe("string");
    expect(r.agent).toBe("ashlr-mcp");
    expect(r.event).toBe("tool_fallback");
    expect(r.tool).toBe("ashlr__grep");
    expect(typeof r.cwd).toBe("string");
    expect(typeof r.session).toBe("string");
    expect((r.session as string).length).toBeGreaterThan(0);
    expect(r.reason).toBe("no-genome");
  });

  test("ts is a valid ISO 8601 timestamp", async () => {
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "small-file" });
    const records = await readLog();
    const ts = records[0]!.ts as string;
    expect(Number.isFinite(Date.parse(ts))).toBe(true);
  });

  test("extra fields are merged into the record at top level", async () => {
    await logEvent("tool_escalate", {
      tool: "ashlr__grep",
      reason: "incomplete-genome",
      extra: { sections: 3, estimated: 42 },
    });
    const records = await readLog();
    const r = records[0]!;
    expect(r.sections).toBe(3);
    expect(r.estimated).toBe(42);
  });

  test("preserves Unicode text in the emitted payload", async () => {
    const text = "東京 café e\u0301 🚀 👩‍💻";
    await logEvent("tool_error", {
      tool: "ashlr__read",
      reason: text,
      extra: { message: text },
    });
    const records = await readLog();
    expect(records).toHaveLength(1);
    expect(records[0]!.reason).toBe(text);
    expect(records[0]!.message).toBe(text);
  });

  test("reason is omitted when not provided", async () => {
    await logEvent("tool_error", { tool: "ashlr__read" });
    const records = await readLog();
    expect("reason" in records[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("ASHLR_SESSION_LOG=0 kill switch", () => {
  test("does not write when kill switch is set", async () => {
    process.env.ASHLR_SESSION_LOG = "0";
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
    expect(existsSync(logPath)).toBe(false);
  });

  test("writes normally when ASHLR_SESSION_LOG is unset", async () => {
    delete process.env.ASHLR_SESSION_LOG;
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
    const records = await readLog();
    expect(records.length).toBe(1);
  });

  test("writes normally when ASHLR_SESSION_LOG=1", async () => {
    process.env.ASHLR_SESSION_LOG = "1";
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "below-threshold" });
    const records = await readLog();
    expect(records.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Missing directory
// ---------------------------------------------------------------------------

describe("missing directory tolerance", () => {
  test("creates .ashlr dir if missing and still writes", async () => {
    // Remove the .ashlr dir that beforeEach created.
    await rm(join(home, ".ashlr"), { recursive: true, force: true });
    // Should not throw.
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
    const records = await readLog();
    expect(records.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple appends
// ---------------------------------------------------------------------------

describe("multiple appends", () => {
  test("each call appends a new line", async () => {
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "small-file" });
    await logEvent("tool_escalate", { tool: "ashlr__grep", reason: "incomplete-genome", extra: { sections: 1, estimated: 10 } });
    const records = await readLog();
    expect(records.length).toBe(3);
    expect(records[0]!.event).toBe("tool_fallback");
    expect(records[1]!.event).toBe("tool_noop");
    expect(records[2]!.event).toBe("tool_escalate");
  });

  test("each line is valid JSON (JSONL format)", async () => {
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "genome-empty" });
    await logEvent("tool_error", { tool: "ashlr__read" });
    const raw = await readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Schema matches hook (fields present in PostToolUse hook records)
// ---------------------------------------------------------------------------

describe("schema matches PostToolUse hook", () => {
  test("has ts, agent, event, tool, cwd, session fields", async () => {
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
    const r = (await readLog())[0]!;
    // These are the same top-level fields the shell hook writes.
    for (const field of ["ts", "agent", "event", "tool", "cwd", "session"]) {
      expect(field in r).toBe(true);
    }
  });
});
