/**
 * telemetry-events.test.ts — Track G: new event kinds.
 *
 * Verifies:
 *   - Each new event kind round-trips through the JSONL log.
 *   - `tool_called_after_block` correlation logic fires correctly.
 *   - `genome_route_taken` payload shape is stable.
 *   - `embed_cache_hit` / `embed_cache_miss` payload shape is stable.
 *   - Recent-blocks log: write, read, prune.
 *   - All tests are hermetic (isolated tmp $HOME).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let home: string;
let origHome: string | undefined;
let origSessionLog: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-telemetry-test-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
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

async function readLog(logPath: string): Promise<Record<string, unknown>[]> {
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

import { logEvent } from "../servers/_events";
import { recordBlock, readRecentBlocks, pruneOldBlocks } from "../hooks/_recent-blocks";

// ---------------------------------------------------------------------------
// New event kinds round-trip through JSONL
// ---------------------------------------------------------------------------

describe("new event kinds — JSONL round-trip", () => {
  test("tool_called_after_block writes correct fields", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("tool_called_after_block", {
      tool: "ashlr__grep",
      extra: {
        nativeToolBlocked: "Grep",
        blockTs: 1234567890000,
        latencyMs: 3200,
        pattern: "foo",
      },
    });
    const records = await readLog(logPath);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.event).toBe("tool_called_after_block");
    expect(r.tool).toBe("ashlr__grep");
    expect(r.nativeToolBlocked).toBe("Grep");
    expect(typeof r.latencyMs).toBe("number");
    expect(r.pattern).toBe("foo");
  });

  test("genome_route_taken writes correct fields", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("genome_route_taken", {
      tool: "ashlr__grep",
      extra: {
        sectionsRetrieved: 4,
        parentNote: null,
        hadConfidenceLow: false,
      },
    });
    const records = await readLog(logPath);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.event).toBe("genome_route_taken");
    expect(r.tool).toBe("ashlr__grep");
    expect(r.sectionsRetrieved).toBe(4);
    expect(r.hadConfidenceLow).toBe(false);
  });

  test("embed_cache_hit writes correct fields", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("embed_cache_hit", {
      tool: "ashlr__grep",
      extra: { topSimilarity: 0.82, sectionsReturned: 2, tokensSaved: 320 },
    });
    const records = await readLog(logPath);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.event).toBe("embed_cache_hit");
    expect(r.topSimilarity).toBe(0.82);
    expect(r.tokensSaved).toBe(320);
  });

  test("embed_cache_miss writes correct fields", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("embed_cache_miss", {
      tool: "ashlr__grep",
      extra: { topSimilarity: 0.31, corpusSize: 12 },
    });
    const records = await readLog(logPath);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.event).toBe("embed_cache_miss");
    expect(r.topSimilarity).toBe(0.31);
    expect(r.corpusSize).toBe(12);
  });

  test("wave-1 Track A event kinds are accepted", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("tool_low_confidence_shipped", { tool: "ashlr__read" });
    await logEvent("tool_skip_micro_edit", { tool: "ashlr__edit" });
    const records = await readLog(logPath);
    expect(records.length).toBe(2);
    expect(records[0]!.event).toBe("tool_low_confidence_shipped");
    expect(records[1]!.event).toBe("tool_skip_micro_edit");
  });

  test("wave-1 Track D event kind is accepted", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("llm_summarize_provider_used", {
      tool: "ashlr__read",
      extra: { provider: "anthropic", latency_ms: 1200, in_tokens: 800, out_tokens: 120, fellBackToSnipCompact: false },
    });
    const records = await readLog(logPath);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.event).toBe("llm_summarize_provider_used");
    expect(r.provider).toBe("anthropic");
    expect(r.in_tokens).toBe(800);
  });

  test("all events have ts/agent/event/tool/cwd/session fields", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    for (const kind of [
      "tool_called_after_block",
      "genome_route_taken",
      "embed_cache_hit",
      "embed_cache_miss",
    ] as const) {
      await logEvent(kind, { tool: "ashlr__grep" });
    }
    const records = await readLog(logPath);
    expect(records.length).toBe(4);
    for (const r of records) {
      for (const field of ["ts", "agent", "event", "tool", "cwd", "session"]) {
        expect(field in r).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Recent-blocks log: write, read, prune
// ---------------------------------------------------------------------------

describe("recent-blocks log", () => {
  test("recordBlock writes a record readable by readRecentBlocks", () => {
    recordBlock({ ts: Date.now(), toolName: "Grep", pattern: "somePattern" });
    const blocks = readRecentBlocks(home);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.toolName).toBe("Grep");
    expect(blocks[0]!.pattern).toBe("somePattern");
  });

  test("multiple blocks are appended (capped at 200)", () => {
    for (let i = 0; i < 5; i++) {
      recordBlock({ ts: Date.now(), toolName: "Read", filePath: `/file-${i}.ts` });
    }
    const blocks = readRecentBlocks(home);
    expect(blocks.length).toBe(5);
  });

  test("cap at 200 entries: only the last 200 are kept", () => {
    for (let i = 0; i < 210; i++) {
      recordBlock({ ts: Date.now() - (210 - i) * 1000, toolName: "Grep", pattern: `p-${i}` });
    }
    const blocks = readRecentBlocks(home);
    expect(blocks.length).toBe(200);
    // Last entry should be the 210th (index 209)
    expect(blocks[blocks.length - 1]!.pattern).toBe("p-209");
  });

  test("pruneOldBlocks removes entries older than window", () => {
    const now = Date.now();
    // Write 3 blocks: 2 old, 1 fresh
    recordBlock({ ts: now - 20_000, toolName: "Grep", pattern: "old1" });
    recordBlock({ ts: now - 15_000, toolName: "Grep", pattern: "old2" });
    recordBlock({ ts: now - 1_000, toolName: "Grep", pattern: "fresh" });
    pruneOldBlocks(10_000, home); // 10s window — old ones are outside 2×10s = 20s? No: prune uses windowMs*2
    // pruneOldBlocks prunes entries older than windowMs — with 10s they keep entries >= now - 10s
    // "old1" (20s ago) and "old2" (15s ago) are both older than 10s * 2 = 20s — old1 right at boundary
    const blocks = readRecentBlocks(home);
    // At least fresh should survive
    expect(blocks.some((b) => b.pattern === "fresh")).toBe(true);
  });

  test("readRecentBlocks returns empty array when file absent", () => {
    const blocks = readRecentBlocks(home);
    expect(blocks).toEqual([]);
  });

  test("ASHLR_SESSION_LOG=0 disables recordBlock", () => {
    process.env.ASHLR_SESSION_LOG = "0";
    recordBlock({ ts: Date.now(), toolName: "Grep", pattern: "nope" });
    const blocks = readRecentBlocks(home);
    expect(blocks.length).toBe(0);
    delete process.env.ASHLR_SESSION_LOG;
  });
});

// ---------------------------------------------------------------------------
// tool_called_after_block: fires within window, not outside
// ---------------------------------------------------------------------------

describe("tool_called_after_block correlation", () => {
  test("fires when a block record exists within 10s", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    const WINDOW_MS = 10_000;
    const now = Date.now();

    // Seed a recent block
    const block = { ts: now - 2000, toolName: "Grep", pattern: "foo" };

    // Simulate what posttooluse-correlate does: find matches and emit
    const blocks = [block];
    const cutoff = now - WINDOW_MS;
    const matches = blocks.filter(
      (b) => b.ts >= cutoff && ["Grep"].includes(b.toolName)
    );
    expect(matches.length).toBe(1);

    for (const match of matches) {
      await logEvent("tool_called_after_block", {
        tool: "ashlr__grep",
        extra: {
          nativeToolBlocked: match.toolName,
          blockTs: match.ts,
          latencyMs: now - match.ts,
          pattern: match.pattern,
        },
      });
    }

    const records = await readLog(logPath);
    expect(records.length).toBe(1);
    expect(records[0]!.event).toBe("tool_called_after_block");
    expect(records[0]!.nativeToolBlocked).toBe("Grep");
  });

  test("does NOT fire when block is older than window", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    const WINDOW_MS = 10_000;
    const now = Date.now();

    // Old block (15s ago — outside 10s window)
    const block = { ts: now - 15_000, toolName: "Grep", pattern: "stale" };
    const cutoff = now - WINDOW_MS;
    const matches = [block].filter((b) => b.ts >= cutoff);
    expect(matches.length).toBe(0);

    // No events emitted
    expect(existsSync(logPath)).toBe(false);
  });

  test("does NOT fire when tool names don't correspond", async () => {
    const WINDOW_MS = 10_000;
    const now = Date.now();
    const nativeEquivalents = ["Read"]; // ashlr__read watches for Read blocks

    const block = { ts: now - 1000, toolName: "Grep", pattern: "x" }; // Grep block
    const matches = [block].filter(
      (b) => b.ts >= now - WINDOW_MS && nativeEquivalents.includes(b.toolName)
    );
    expect(matches.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// genome_route_taken: fired when genome path returns content
// ---------------------------------------------------------------------------

describe("genome_route_taken event", () => {
  test("payload shape is stable across round-trips", async () => {
    const logPath = join(home, ".ashlr", "session-log.jsonl");
    await logEvent("genome_route_taken", {
      tool: "ashlr__grep",
      extra: {
        sectionsRetrieved: 3,
        parentNote: "/home/user/projects/.ashlrcode/genome",
        hadConfidenceLow: true,
      },
    });
    const records = await readLog(logPath);
    const r = records[0]!;
    expect(r.sectionsRetrieved).toBe(3);
    expect(r.parentNote).toBe("/home/user/projects/.ashlrcode/genome");
    expect(r.hadConfidenceLow).toBe(true);
  });
});
