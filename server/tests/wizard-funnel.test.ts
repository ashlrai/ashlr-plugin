/**
 * wizard-funnel.test.ts — Stage 1.2 tests for adminGetWizardFunnel.
 *
 * Coverage:
 *   - Returns ordered array matching canonical wizard step sequence
 *   - Counts distinct session_id_hash (dedupes re-renders)
 *   - Steps outside canonical order are appended at end
 *   - Respects windowHours cutoff (old events excluded)
 *   - Returns empty array when no wizard_step events exist
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getDb } from "../src/db.js";
import { adminGetWizardFunnel, adminGetWizardProConversion } from "../src/db.js";

const CANONICAL = ["intro", "doctor", "permissions", "status_line", "genome_init", "pro_teaser", "complete"] as const;

function cleanTelemetry() {
  getDb().exec("DELETE FROM telemetry_events");
}

/** Insert a wizard_step event directly into telemetry_events. */
function insertWizardStep(
  sessionHash: string,
  stepName: string,
  tsOffsetSeconds = 0,
) {
  const ts = Math.floor(Date.now() / 1000) - tsOffsetSeconds;
  getDb().run(
    `INSERT INTO telemetry_events (session_id_hash, ts, kind, payload) VALUES (?, ?, 'wizard_step', ?)`,
    [sessionHash, ts, JSON.stringify({ step_name: stepName, outcome: "completed" })],
  );
}

/** Insert a wizard_pro_pitch event with the given outcome ('y' | 'n' | 'skip'). */
function insertProPitchEvent(
  sessionHash: string,
  outcome: string,
  tsOffsetSeconds = 0,
) {
  const ts = Math.floor(Date.now() / 1000) - tsOffsetSeconds;
  getDb().run(
    `INSERT INTO telemetry_events (session_id_hash, ts, kind, payload) VALUES (?, ?, 'wizard_pro_pitch', ?)`,
    [sessionHash, ts, JSON.stringify({ outcome })],
  );
}

describe("adminGetWizardFunnel — basic shape", () => {
  beforeEach(cleanTelemetry);

  it("returns empty array when no wizard_step events exist", () => {
    const result = adminGetWizardFunnel(24);
    expect(result).toEqual([]);
  });

  it("returns one step row with correct count", () => {
    insertWizardStep("sess1", "intro");
    const result = adminGetWizardFunnel(24);
    expect(result.length).toBe(1);
    expect(result[0]!.step_name).toBe("intro");
    expect(result[0]!.sessions_reached).toBe(1);
  });
});

describe("adminGetWizardFunnel — deduplication", () => {
  beforeEach(cleanTelemetry);

  it("counts distinct session_id_hash (dedupes re-renders of same step)", () => {
    // session A visits "intro" 3 times (re-renders)
    insertWizardStep("sessA", "intro");
    insertWizardStep("sessA", "intro");
    insertWizardStep("sessA", "intro");
    // session B visits "intro" once
    insertWizardStep("sessB", "intro");

    const result = adminGetWizardFunnel(24);
    const intro = result.find((r) => r.step_name === "intro");
    expect(intro).toBeTruthy();
    // Only 2 distinct sessions reached intro (A and B)
    expect(intro!.sessions_reached).toBe(2);
  });

  it("counts each step independently across sessions", () => {
    // 3 sessions reach intro; only 2 reach doctor
    insertWizardStep("s1", "intro");
    insertWizardStep("s2", "intro");
    insertWizardStep("s3", "intro");
    insertWizardStep("s1", "doctor");
    insertWizardStep("s2", "doctor");

    const result = adminGetWizardFunnel(24);
    const intro  = result.find((r) => r.step_name === "intro");
    const doctor = result.find((r) => r.step_name === "doctor");
    expect(intro!.sessions_reached).toBe(3);
    expect(doctor!.sessions_reached).toBe(2);
  });
});

describe("adminGetWizardFunnel — canonical ordering", () => {
  beforeEach(cleanTelemetry);

  it("returns steps sorted in canonical wizard order regardless of insertion order", () => {
    // Insert in reverse canonical order
    for (const step of [...CANONICAL].reverse()) {
      insertWizardStep(`sess-${step}`, step);
    }

    const result = adminGetWizardFunnel(24);
    // Filter to only canonical steps (all should be present)
    const names = result.map((r) => r.step_name);
    const canonicalInResult = names.filter((n) => CANONICAL.includes(n as typeof CANONICAL[number]));

    // Must appear in canonical order
    for (let i = 0; i < canonicalInResult.length - 1; i++) {
      const iA = CANONICAL.indexOf(canonicalInResult[i] as typeof CANONICAL[number]);
      const iB = CANONICAL.indexOf(canonicalInResult[i + 1] as typeof CANONICAL[number]);
      expect(iA).toBeLessThan(iB);
    }
  });

  it("appends unknown (non-canonical) steps after all canonical steps", () => {
    insertWizardStep("s1", "intro");
    insertWizardStep("s2", "future_step_xyz"); // not in canonical list

    const result = adminGetWizardFunnel(24);
    const names = result.map((r) => r.step_name);
    const introIdx = names.indexOf("intro");
    const unknownIdx = names.indexOf("future_step_xyz");
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(unknownIdx).toBeGreaterThan(introIdx);
  });
});

describe("adminGetWizardFunnel — windowHours cutoff", () => {
  beforeEach(cleanTelemetry);

  it("excludes events older than windowHours", () => {
    // Recent event (within 1h window)
    insertWizardStep("s1", "intro", 0);
    // Old event (3 hours ago, outside 1h window)
    insertWizardStep("s2", "intro", 3 * 3600);

    const result = adminGetWizardFunnel(1); // 1-hour window
    const intro = result.find((r) => r.step_name === "intro");
    // Only s1 should be counted
    expect(intro!.sessions_reached).toBe(1);
  });

  it("includes all events within the window", () => {
    insertWizardStep("s1", "doctor", 0);
    insertWizardStep("s2", "doctor", 23 * 3600); // 23h ago — within 24h window
    insertWizardStep("s3", "doctor", 25 * 3600); // 25h ago — outside 24h window

    const result = adminGetWizardFunnel(24);
    const doctor = result.find((r) => r.step_name === "doctor");
    // s1 + s2 = 2 distinct sessions within window
    expect(doctor!.sessions_reached).toBe(2);
  });
});

describe("adminGetWizardFunnel — full funnel shape", () => {
  beforeEach(cleanTelemetry);

  it("returns all 7 canonical steps when all are seeded, decreasing counts", () => {
    // Simulate a realistic funnel: each step has fewer sessions
    const counts: Record<string, number> = {
      intro: 100,
      doctor: 80,
      permissions: 70,
      status_line: 60,
      genome_init: 40,
      pro_teaser: 20,
      complete: 10,
    };

    for (const [step, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        insertWizardStep(`sess-${step}-${i}`, step);
      }
    }

    const result = adminGetWizardFunnel(24);
    expect(result.length).toBe(7);

    // Verify each step name and count
    for (const r of result) {
      expect(r.sessions_reached).toBe(counts[r.step_name]);
    }

    // Verify order
    const names = result.map((r) => r.step_name);
    expect(names).toEqual(Array.from(CANONICAL));
  });
});

// ---------------------------------------------------------------------------
// New: dropoff_pct + cumulative_pct math
// ---------------------------------------------------------------------------

describe("adminGetWizardFunnel — dropoff_pct and cumulative_pct", () => {
  beforeEach(cleanTelemetry);

  it("first step has null dropoff_pct and null cumulative_pct", () => {
    for (let i = 0; i < 100; i++) insertWizardStep(`s-intro-${i}`, "intro");
    const result = adminGetWizardFunnel(24);
    const intro = result.find((r) => r.step_name === "intro")!;
    expect(intro.dropoff_pct).toBeNull();
    expect(intro.cumulative_pct).toBeNull();
  });

  it("computes correct dropoff_pct and cumulative_pct for synthetic 100→90→75→60→50→40 funnel", () => {
    // 6-step funnel using first 6 canonical steps (intro through pro_teaser)
    const stepCounts: [string, number][] = [
      ["intro",       100],
      ["doctor",       90],
      ["permissions",  75],
      ["status_line",  60],
      ["genome_init",  50],
      ["pro_teaser",   40],
    ];
    for (const [step, n] of stepCounts) {
      for (let i = 0; i < n; i++) insertWizardStep(`s-${step}-${i}`, step);
    }

    const result = adminGetWizardFunnel(24);
    const byName = new Map(result.map((r) => [r.step_name, r]));

    // intro: null / null
    expect(byName.get("intro")!.dropoff_pct).toBeNull();
    expect(byName.get("intro")!.cumulative_pct).toBeNull();

    // doctor: dropped 10 from 100 → 10%
    expect(byName.get("doctor")!.dropoff_pct).toBeCloseTo(10, 1);
    // cumulative: 90/100 = 90%
    expect(byName.get("doctor")!.cumulative_pct).toBeCloseTo(90, 1);

    // permissions: dropped 15 from 90 → 16.7%
    expect(byName.get("permissions")!.dropoff_pct).toBeCloseTo(16.67, 1);
    // cumulative: 75/100 = 75%
    expect(byName.get("permissions")!.cumulative_pct).toBeCloseTo(75, 1);

    // status_line: dropped 15 from 75 → 20%
    expect(byName.get("status_line")!.dropoff_pct).toBeCloseTo(20, 1);
    // cumulative: 60/100 = 60%
    expect(byName.get("status_line")!.cumulative_pct).toBeCloseTo(60, 1);

    // genome_init: dropped 10 from 60 → 16.7%
    expect(byName.get("genome_init")!.dropoff_pct).toBeCloseTo(16.67, 1);
    // cumulative: 50/100 = 50%
    expect(byName.get("genome_init")!.cumulative_pct).toBeCloseTo(50, 1);

    // pro_teaser: dropped 10 from 50 → 20%
    expect(byName.get("pro_teaser")!.dropoff_pct).toBeCloseTo(20, 1);
    // cumulative: 40/100 = 40%
    expect(byName.get("pro_teaser")!.cumulative_pct).toBeCloseTo(40, 1);
  });

  it("handles zero drop-off (step count equal to previous)", () => {
    for (let i = 0; i < 50; i++) insertWizardStep(`s-intro-${i}`, "intro");
    for (let i = 0; i < 50; i++) insertWizardStep(`s-doctor-${i}`, "doctor");
    const result = adminGetWizardFunnel(24);
    const doctor = result.find((r) => r.step_name === "doctor")!;
    expect(doctor.dropoff_pct).toBeCloseTo(0, 1);
    expect(doctor.cumulative_pct).toBeCloseTo(100, 1);
  });
});

// ---------------------------------------------------------------------------
// New: Pro conversion proxy
// ---------------------------------------------------------------------------

describe("adminGetWizardProConversion", () => {
  beforeEach(cleanTelemetry);

  it("returns zeros when no events exist", () => {
    const result = adminGetWizardProConversion(24);
    expect(result.wizard_completed).toBe(0);
    expect(result.wizard_pro_yes).toBe(0);
    expect(result.conversion_pct).toBe(0);
  });

  it("counts wizard_step complete events as wizard_completed", () => {
    insertWizardStep("sA", "complete");
    insertWizardStep("sB", "complete");
    insertWizardStep("sC", "intro"); // not complete — should not count
    const result = adminGetWizardProConversion(24);
    expect(result.wizard_completed).toBe(2);
  });

  it("counts only wizard_pro_pitch events with outcome='y'", () => {
    insertWizardStep("sA", "complete");
    insertWizardStep("sB", "complete");
    insertWizardStep("sC", "complete");
    insertProPitchEvent("sA", "y");
    insertProPitchEvent("sB", "n");   // outcome=n — should NOT count
    insertProPitchEvent("sC", "skip"); // outcome=skip — should NOT count
    const result = adminGetWizardProConversion(24);
    expect(result.wizard_pro_yes).toBe(1);
  });

  it("computes conversion_pct correctly", () => {
    // 4 completed, 1 pro-yes → 25%
    for (let i = 0; i < 4; i++) insertWizardStep(`s${i}`, "complete");
    insertProPitchEvent("s0", "y");
    const result = adminGetWizardProConversion(24);
    expect(result.wizard_completed).toBe(4);
    expect(result.wizard_pro_yes).toBe(1);
    expect(result.conversion_pct).toBeCloseTo(25, 1);
  });

  it("deduplicates session_id_hash for pro_yes count", () => {
    // Same session fires wizard_pro_pitch y twice (double-fire guard)
    insertWizardStep("sA", "complete");
    insertProPitchEvent("sA", "y");
    insertProPitchEvent("sA", "y");
    const result = adminGetWizardProConversion(24);
    expect(result.wizard_pro_yes).toBe(1); // DISTINCT
  });

  it("respects windowHours cutoff for both completed and pro_yes", () => {
    insertWizardStep("sA", "complete", 0);
    insertWizardStep("sB", "complete", 3 * 3600); // outside 1h window
    insertProPitchEvent("sA", "y", 0);
    insertProPitchEvent("sB", "y", 3 * 3600); // outside 1h window
    const result = adminGetWizardProConversion(1); // 1-hour window
    expect(result.wizard_completed).toBe(1);
    expect(result.wizard_pro_yes).toBe(1);
  });
});
