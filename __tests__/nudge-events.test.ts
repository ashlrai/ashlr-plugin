/**
 * Unit tests for servers/_nudge-events.ts.
 *
 * Tests the three-state lifecycle (shown / clicked / dismissed) plus dedupe,
 * correlation window, bucketing, summary aggregation, and status-line wiring
 * via the live buildStatusLine() renderer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  _resetSessionState,
  bucketTokenCount,
  hashSessionId,
  nudgeEventsPath,
  readNudgeSummary,
  recordNudgeClicked,
  recordNudgeDismissedIfPending,
  recordNudgeShown,
} from "../servers/_nudge-events";
import { buildStatusLine } from "../scripts/savings-status-line";

let home: string;
const RAW_SID = "test-raw-session-id";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-nudge-test-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  await _resetSessionState(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function readLines(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(nudgeEventsPath(home), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
}

describe("bucketTokenCount", () => {
  test("buckets into 50k / 100k / 500k / 1m", () => {
    expect(bucketTokenCount(49_000)).toBe(0);
    expect(bucketTokenCount(50_000)).toBe(50_000);
    expect(bucketTokenCount(75_000)).toBe(50_000);
    expect(bucketTokenCount(100_000)).toBe(100_000);
    expect(bucketTokenCount(499_999)).toBe(100_000);
    expect(bucketTokenCount(500_000)).toBe(500_000);
    expect(bucketTokenCount(1_000_000)).toBe(1_000_000);
    expect(bucketTokenCount(9_999_999)).toBe(1_000_000);
  });

  test("0 / NaN / negative → 0", () => {
    expect(bucketTokenCount(0)).toBe(0);
    expect(bucketTokenCount(NaN)).toBe(0);
    expect(bucketTokenCount(-5)).toBe(0);
  });
});

describe("hashSessionId", () => {
  test("is deterministic and short", () => {
    const a = hashSessionId("abc");
    const b = hashSessionId("abc");
    const c = hashSessionId("def");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(a)).toBe(true);
  });

  test("never equals the raw input", () => {
    expect(hashSessionId("mason@example.com")).not.toContain("mason");
    expect(hashSessionId("/Users/mason/secret")).not.toContain("Users");
  });
});

describe("recordNudgeShown", () => {
  test("writes a jsonl line with the expected shape", async () => {
    const r = await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, home });
    expect(r.wrote).toBe(true);
    expect(r.nudgeId.length).toBeGreaterThan(0);

    const lines = await readLines();
    expect(lines.length).toBe(1);
    const rec = lines[0]!;
    expect(rec.event).toBe("nudge_shown");
    expect(rec.tokenCount).toBe(50_000); // bucketed
    expect(rec.variant).toBe("v1");
    expect(typeof rec.nudgeId).toBe("string");
    expect(rec.sessionId).toBe(hashSessionId(RAW_SID));
    // No PII fields.
    expect("cwd" in rec).toBe(false);
    expect("path" in rec).toBe(false);
  });

  test("dedupes within the 1-hour window (same session)", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    const first = await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    const second = await recordNudgeShown({ tokenCount: 80_000, rawSessionId: RAW_SID, now: now + 30 * 60_000, home });
    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    expect(second.nudgeId).toBe(first.nudgeId);
    const lines = await readLines();
    expect(lines.length).toBe(1);
  });

  test("re-emits after the dedupe window expires, keeping the same nudgeId", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    const first = await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    const second = await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now: now + 61 * 60_000, home });
    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(true);
    expect(second.nudgeId).toBe(first.nudgeId);
    expect((await readLines()).length).toBe(2);
  });
});

describe("recordNudgeClicked", () => {
  test("correlates to a recent nudge_shown within 30 min", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    const shown = await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    await recordNudgeClicked({ rawSessionId: RAW_SID, now: now + 10 * 60_000, home });
    const lines = await readLines();
    expect(lines.length).toBe(2);
    const click = lines[1]!;
    expect(click.event).toBe("nudge_clicked");
    expect(click.nudgeId).toBe(shown.nudgeId);
    expect(click.tokenCount).toBe(50_000);
    expect(click.variant).toBe("v1");
  });

  test("click outside window → logs with nudgeId 'none'", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    await recordNudgeClicked({ rawSessionId: RAW_SID, now: now + 60 * 60_000, home });
    const lines = await readLines();
    const click = lines[1]!;
    expect(click.event).toBe("nudge_clicked");
    expect(click.nudgeId).toBe("none");
  });

  test("click without a prior shown → logs with 'none' nudgeId", async () => {
    await recordNudgeClicked({ rawSessionId: RAW_SID, home });
    const lines = await readLines();
    expect(lines.length).toBe(1);
    expect(lines[0]!.event).toBe("nudge_clicked");
    expect(lines[0]!.nudgeId).toBe("none");
  });

  test("shown → clicked within window counts as conversion in summary", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    await recordNudgeClicked({ rawSessionId: RAW_SID, now: now + 5 * 60_000, home });
    const s = await readNudgeSummary(home);
    expect(s.shown).toBe(1);
    expect(s.clicked).toBe(1);
    expect(s.dismissed).toBe(0);
    expect(s.conversionPct).toBe(100);
  });
});

describe("recordNudgeDismissedIfPending", () => {
  test("emits dismissal when shown but not clicked", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    const ok = await recordNudgeDismissedIfPending({ rawSessionId: RAW_SID, now: now + 60 * 60_000, home });
    expect(ok).toBe(true);
    const lines = await readLines();
    expect(lines.length).toBe(2);
    expect(lines[1]!.event).toBe("nudge_dismissed_implicitly");
  });

  test("does NOT emit dismissal when a click occurred", async () => {
    const now = Date.parse("2025-04-21T12:00:00Z");
    await recordNudgeShown({ tokenCount: 75_000, rawSessionId: RAW_SID, now, home });
    await recordNudgeClicked({ rawSessionId: RAW_SID, now: now + 5 * 60_000, home });
    const ok = await recordNudgeDismissedIfPending({ rawSessionId: RAW_SID, now: now + 60 * 60_000, home });
    expect(ok).toBe(false);
    const lines = await readLines();
    expect(lines.map((l) => l.event)).toEqual(["nudge_shown", "nudge_clicked"]);
  });

  test("no-op when no shown event ever occurred", async () => {
    const ok = await recordNudgeDismissedIfPending({ rawSessionId: RAW_SID, home });
    expect(ok).toBe(false);
    expect(existsSync(nudgeEventsPath(home))).toBe(false);
  });
});

describe("readNudgeSummary", () => {
  test("returns zeros when no jsonl exists", async () => {
    const s = await readNudgeSummary(home);
    expect(s).toEqual({ shown: 0, clicked: 0, dismissed: 0, conversionPct: 0 });
  });

  test("counts events across many sessions with conversion-rate math", async () => {
    // Hand-craft 5 shown / 2 clicked / 3 dismissed
    const lines = [
      { event: "nudge_shown", ts: "2025-04-21T12:00:00Z", sessionId: "a", tokenCount: 50_000, variant: "v1", nudgeId: "n1" },
      { event: "nudge_clicked", ts: "2025-04-21T12:05:00Z", sessionId: "a", tokenCount: 50_000, variant: "v1", nudgeId: "n1" },
      { event: "nudge_shown", ts: "2025-04-21T13:00:00Z", sessionId: "b", tokenCount: 50_000, variant: "v1", nudgeId: "n2" },
      { event: "nudge_dismissed_implicitly", ts: "2025-04-21T13:30:00Z", sessionId: "b", tokenCount: 50_000, variant: "v1", nudgeId: "n2" },
      { event: "nudge_shown", ts: "2025-04-21T14:00:00Z", sessionId: "c", tokenCount: 100_000, variant: "v1", nudgeId: "n3" },
      { event: "nudge_clicked", ts: "2025-04-21T14:10:00Z", sessionId: "c", tokenCount: 100_000, variant: "v1", nudgeId: "n3" },
      { event: "nudge_shown", ts: "2025-04-21T15:00:00Z", sessionId: "d", tokenCount: 50_000, variant: "v1", nudgeId: "n4" },
      { event: "nudge_dismissed_implicitly", ts: "2025-04-21T15:45:00Z", sessionId: "d", tokenCount: 50_000, variant: "v1", nudgeId: "n4" },
      { event: "nudge_shown", ts: "2025-04-21T16:00:00Z", sessionId: "e", tokenCount: 50_000, variant: "v1", nudgeId: "n5" },
      { event: "nudge_dismissed_implicitly", ts: "2025-04-21T16:45:00Z", sessionId: "e", tokenCount: 50_000, variant: "v1", nudgeId: "n5" },
    ];
    await writeFile(nudgeEventsPath(home), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const s = await readNudgeSummary(home);
    expect(s.shown).toBe(5);
    expect(s.clicked).toBe(2);
    expect(s.dismissed).toBe(3);
    expect(s.conversionPct).toBe(40);
  });

  test("tolerates malformed lines", async () => {
    await writeFile(
      nudgeEventsPath(home),
      '{"event":"nudge_shown","sessionId":"a","tokenCount":50000,"variant":"v1","nudgeId":"n1","ts":"2025-04-21T12:00:00Z"}\n' +
      "{not json\n" +
      '{"event":"nudge_clicked","sessionId":"a","tokenCount":50000,"variant":"v1","nudgeId":"n1","ts":"2025-04-21T12:05:00Z"}\n',
    );
    const s = await readNudgeSummary(home);
    expect(s.shown).toBe(1);
    expect(s.clicked).toBe(1);
    expect(s.conversionPct).toBe(100);
  });
});

describe("status-line integration — nudge_shown fires when nudge renders", () => {
  test("free user over threshold → renders nudge AND writes a jsonl line", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const stats = {
      schemaVersion: 2,
      sessions: { SID1: { startedAt: "2025-04-21T12:00:00Z", lastSavingAt: null, calls: 10, tokensSaved: 75_000, byTool: {} } },
      lifetime: { calls: 10, tokensSaved: 75_000, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: "SID1", COLUMNS: "200" },
      budget: 200,
    });
    expect(line).toContain("/ashlr-upgrade");
    // Allow async append to land.
    await new Promise((r) => setTimeout(r, 60));
    const lines = await readLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]!.event).toBe("nudge_shown");
    expect(lines[0]!.tokenCount).toBe(50_000);
  });

  test("pro user (pro-token present) → no nudge, no telemetry line", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".ashlr", "pro-token"), "pro-abc-123");
    const stats = {
      schemaVersion: 2,
      sessions: { SID2: { startedAt: "2025-04-21T12:00:00Z", lastSavingAt: null, calls: 10, tokensSaved: 75_000, byTool: {} } },
      lifetime: { calls: 10, tokensSaved: 75_000, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: "SID2", COLUMNS: "200" },
      budget: 200,
    });
    expect(line).not.toContain("/ashlr-upgrade");
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(nudgeEventsPath(home))).toBe(false);
  });

  test("suppressNudgeTelemetry → nudge renders but no event writes", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const stats = {
      schemaVersion: 2,
      sessions: { SID3: { startedAt: "2025-04-21T12:00:00Z", lastSavingAt: null, calls: 10, tokensSaved: 75_000, byTool: {} } },
      lifetime: { calls: 10, tokensSaved: 75_000, byTool: {}, byDay: {} },
    };
    await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
    const line = buildStatusLine({
      home,
      tipSeed: 0,
      env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: "SID3", COLUMNS: "200" },
      budget: 200,
      suppressNudgeTelemetry: true,
    });
    expect(line).toContain("/ashlr-upgrade");
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(nudgeEventsPath(home))).toBe(false);
  });
});

describe("nudge-events.jsonl rotation", () => {
  test("rotates at 10 MB — live file truncates, .1 preserves prior data", async () => {
    const p = nudgeEventsPath(home);
    const padding = "x".repeat(1024);
    const line = `{"event":"nudge_shown","pad":"${padding}"}\n`;
    const chunkLines = Math.ceil((10 * 1024 * 1024) / line.length) + 1;
    await writeFile(p, line.repeat(chunkLines));

    await recordNudgeShown({ rawSessionId: RAW_SID, tokenCount: 50_000, home });

    expect(existsSync(p + ".1")).toBe(true);
    const liveAfter = await readFile(p, "utf-8");
    const rotatedAfter = await readFile(p + ".1", "utf-8");
    expect(rotatedAfter.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(liveAfter.length).toBeLessThan(10 * 1024);
    const parsed = JSON.parse(liveAfter.trim());
    expect(parsed.event).toBe("nudge_shown");
  });

  test("cascades .1 → .2 so repeat rotations don't clobber prior data", async () => {
    const p = nudgeEventsPath(home);
    const padding = "x".repeat(1024);
    const line = `{"event":"nudge_shown","pad":"${padding}"}\n`;
    const chunkLines = Math.ceil((10 * 1024 * 1024) / line.length) + 1;

    await writeFile(p, line.repeat(chunkLines));
    await recordNudgeShown({ rawSessionId: RAW_SID, tokenCount: 50_000, home });
    expect(existsSync(p + ".1")).toBe(true);

    await writeFile(p + ".1", "FIRST_GENERATION\n" + line.repeat(chunkLines));

    await writeFile(p, line.repeat(chunkLines));
    await _resetSessionState(home);
    await recordNudgeShown({ rawSessionId: "second-session", tokenCount: 50_000, home });
    expect(existsSync(p + ".2")).toBe(true);
    const r2 = await readFile(p + ".2", "utf-8");
    expect(r2.startsWith("FIRST_GENERATION")).toBe(true);
  });

  test("no rotation under the 10 MB threshold", async () => {
    const p = nudgeEventsPath(home);
    await writeFile(p, "{\"event\":\"nudge_shown\"}\n".repeat(100));
    await recordNudgeShown({ rawSessionId: RAW_SID, tokenCount: 50_000, home });
    expect(existsSync(p + ".1")).toBe(false);
    const lines = (await readFile(p, "utf-8")).trim().split("\n");
    expect(lines.length).toBe(101);
  });
});
