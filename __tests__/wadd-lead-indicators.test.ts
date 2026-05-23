/**
 * wadd-lead-indicators.test.ts — Client-side coverage for the WAD-D lead
 * indicator fields newly populated from the daily heartbeat.
 *
 * Scenarios:
 *   1. markOnboardingComplete stamps stats.json (first-write wins).
 *   2. recordSaving sets first_savings_at on the first call that clears
 *      FIRST_SAVINGS_THRESHOLD_TOKENS; subsequent calls leave it alone.
 *   3. recordSaving below threshold does NOT set first_savings_at.
 *   4. emitDailyHeartbeat ships the leadIndicators block when present.
 *   5. emitDailyHeartbeat backward compat — payload without leadIndicators
 *      still parses + posts cleanly (no extra keys).
 *   6. sanitizeLeadIndicators drops malformed fields.
 *   7. getStatusLineEnabled honors ashlr.statusLine=false in settings.json.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  _drainWrites,
  _resetMemCache,
  FIRST_SAVINGS_THRESHOLD_TOKENS,
  bumpSavingsInvocation,
  currentIsoWeek,
  getStatusLineEnabled,
  markOnboardingComplete,
  readLeadIndicatorSnapshot,
  readStats,
  recordSaving,
} from "../servers/_stats";
import {
  _resetDailyHeartbeatMemo,
  _setDailyHeartbeatFetch,
  _setDailyHeartbeatUrl,
  emitDailyHeartbeat,
  sanitizeLeadIndicators,
} from "../servers/_telemetry";

let home: string;
const originalHome = process.env.HOME;
const originalSession = process.env.CLAUDE_SESSION_ID;
const originalSync = process.env.ASHLR_STATS_SYNC;
const originalTel = process.env.ASHLR_TELEMETRY;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-wadd-lead-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_SESSION_ID = "test-wadd-lead";
  process.env.ASHLR_STATS_SYNC = "1";  // synchronous writes — test determinism
  process.env.ASHLR_TELEMETRY = "on";  // opt-in for heartbeat
  _resetDailyHeartbeatMemo();
});

afterEach(async () => {
  await _drainWrites();
  process.env.HOME = originalHome;
  if (originalSession) process.env.CLAUDE_SESSION_ID = originalSession;
  else delete process.env.CLAUDE_SESSION_ID;
  if (originalSync !== undefined) process.env.ASHLR_STATS_SYNC = originalSync;
  else delete process.env.ASHLR_STATS_SYNC;
  if (originalTel !== undefined) process.env.ASHLR_TELEMETRY = originalTel;
  else delete process.env.ASHLR_TELEMETRY;
  _resetMemCache();
  _setDailyHeartbeatFetch(null);
  _setDailyHeartbeatUrl(null);
  await rm(home, { recursive: true, force: true });
});

describe("markOnboardingComplete", () => {
  test("stamps onboarding_completed_at on first call", async () => {
    await markOnboardingComplete("2026-05-22T10:00:00.000Z");
    const stats = await readStats();
    expect(stats.onboarding_completed_at).toBe("2026-05-22T10:00:00.000Z");
  });

  test("does NOT overwrite an existing stamp", async () => {
    await markOnboardingComplete("2026-05-22T10:00:00.000Z");
    await markOnboardingComplete("2026-05-23T11:00:00.000Z");
    const stats = await readStats();
    expect(stats.onboarding_completed_at).toBe("2026-05-22T10:00:00.000Z");
  });
});

describe("recordSaving first_savings_at", () => {
  test("threshold-clearing first call sets first_savings_at", async () => {
    // tokensSaved math: ceil((raw - compact) / 4). 1000 raw, 0 compact → 250.
    // 250 > FIRST_SAVINGS_THRESHOLD_TOKENS (100) → field gets set.
    expect(FIRST_SAVINGS_THRESHOLD_TOKENS).toBe(100);
    await recordSaving(1000, 0, "ashlr__grep");
    const stats = await readStats();
    expect(stats.first_savings_at).toBeTruthy();
  });

  test("subsequent recordSaving calls don't overwrite first_savings_at", async () => {
    await recordSaving(1000, 0, "ashlr__grep");
    const stats1 = await readStats();
    const stamped = stats1.first_savings_at!;
    // sleep 5ms so any inadvertent overwrite would be detectable.
    await new Promise((r) => setTimeout(r, 5));
    await recordSaving(2000, 0, "ashlr__grep");
    const stats2 = await readStats();
    expect(stats2.first_savings_at).toBe(stamped);
  });

  test("below-threshold recordSaving does NOT set first_savings_at", async () => {
    // raw=200, compact=100 → ceil(100/4) = 25 saved tokens; below 100 threshold.
    await recordSaving(200, 100, "ashlr__grep");
    const stats = await readStats();
    expect(stats.first_savings_at).toBeUndefined();
  });
});

describe("bumpSavingsInvocation", () => {
  test("increments the current ISO-week bucket", async () => {
    const now = new Date("2026-05-22T10:00:00.000Z");
    await bumpSavingsInvocation(now);
    await bumpSavingsInvocation(now);
    const stats = await readStats();
    const week = currentIsoWeek(now);
    expect(stats.savings_invocations_by_week?.[week]).toBe(2);
  });
});

describe("getStatusLineEnabled", () => {
  test("defaults to true when settings.json is absent", () => {
    expect(getStatusLineEnabled(home)).toBe(true);
  });

  test("respects ashlr.statusLine=false", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ ashlr: { statusLine: false } }),
    );
    expect(getStatusLineEnabled(home)).toBe(false);
  });

  test("returns true when ashlr.statusLine is true", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ ashlr: { statusLine: true } }),
    );
    expect(getStatusLineEnabled(home)).toBe(true);
  });
});

describe("readLeadIndicatorSnapshot", () => {
  test("composes from stats.json + status-line config", async () => {
    await markOnboardingComplete();
    await recordSaving(1000, 0, "ashlr__grep");
    await bumpSavingsInvocation();
    const snap = await readLeadIndicatorSnapshot(home);
    expect(snap.onboarding_completed).toBe(true);
    expect(snap.first_savings_at).toBeTruthy();
    expect(snap.savings_invocations_this_week).toBe(1);
    expect(snap.status_line_enabled).toBe(true);
  });
});

describe("emitDailyHeartbeat with lead indicators", () => {
  test("ships leadIndicators block when present", async () => {
    let posted: { url: string; body: unknown } | null = null;
    _setDailyHeartbeatUrl("http://test/stats/daily-active");
    _setDailyHeartbeatFetch((async (url: string, init: any) => {
      posted = { url, body: JSON.parse(init.body as string) };
      return new Response("{}", { status: 202 });
    }) as any);
    emitDailyHeartbeat({
      machineHash: "a".repeat(64),
      githubHash: null,
      date: "2026-05-22",
      pluginVersion: "1.31.0",
      leadIndicators: {
        onboarding_completed: true,
        status_line_enabled: true,
        first_savings_at: "2026-05-22T10:00:00.000Z",
        streak_days: 5,
        savings_invocations_this_week: 3,
        nudge_accept_rate: 0.4,
      },
    });
    // Drain the fire-and-forget Promise.
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).not.toBeNull();
    const body = posted!.body as Record<string, unknown>;
    expect(body["identity_hash"]).toBe("a".repeat(64));
    expect(body["date"]).toBe("2026-05-22");
    const li = body["lead_indicators"] as Record<string, unknown>;
    expect(li["onboarding_completed"]).toBe(true);
    expect(li["status_line_enabled"]).toBe(true);
    expect(li["first_savings_at"]).toBe("2026-05-22T10:00:00.000Z");
    expect(li["streak_days"]).toBe(5);
    expect(li["savings_invocations_this_week"]).toBe(3);
    expect(li["nudge_accept_rate"]).toBe(0.4);
  });

  test("backward compat — payload without leadIndicators omits lead_indicators key", async () => {
    let posted: { body: unknown } | null = null;
    _setDailyHeartbeatUrl("http://test/stats/daily-active");
    _setDailyHeartbeatFetch((async (_url: string, init: any) => {
      posted = { body: JSON.parse(init.body as string) };
      return new Response("{}", { status: 202 });
    }) as any);
    emitDailyHeartbeat({
      machineHash: "a".repeat(64),
      githubHash: null,
      date: "2026-05-22",
      pluginVersion: "1.31.0",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).not.toBeNull();
    const body = posted!.body as Record<string, unknown>;
    expect(body["identity_hash"]).toBe("a".repeat(64));
    expect("lead_indicators" in body).toBe(false);
  });
});

describe("sanitizeLeadIndicators", () => {
  test("passes valid fields through unchanged", () => {
    const out = sanitizeLeadIndicators({
      onboarding_completed: true,
      status_line_enabled: false,
      first_savings_at: "2026-05-22T10:00:00.000Z",
      streak_days: 7,
      savings_invocations_this_week: 4,
      nudge_accept_rate: 0.5,
    });
    expect(out).toEqual({
      onboarding_completed: true,
      status_line_enabled: false,
      first_savings_at: "2026-05-22T10:00:00.000Z",
      streak_days: 7,
      savings_invocations_this_week: 4,
      nudge_accept_rate: 0.5,
    });
  });

  test("drops out-of-range nudge_accept_rate", () => {
    const out = sanitizeLeadIndicators({
      nudge_accept_rate: 1.5,
    });
    expect("nudge_accept_rate" in out).toBe(false);
  });

  test("drops non-boolean onboarding_completed", () => {
    const out = sanitizeLeadIndicators({
      // @ts-expect-error — invalid value, testing the guard.
      onboarding_completed: "yes",
    });
    expect("onboarding_completed" in out).toBe(false);
  });

  test("explicit null first_savings_at survives", () => {
    const out = sanitizeLeadIndicators({ first_savings_at: null });
    expect(out["first_savings_at"]).toBe(null);
  });

  test("negative streak_days dropped", () => {
    const out = sanitizeLeadIndicators({ streak_days: -1 });
    expect("streak_days" in out).toBe(false);
  });
});
