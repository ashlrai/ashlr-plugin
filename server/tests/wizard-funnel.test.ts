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
import { adminGetWizardFunnel } from "../src/db.js";

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
