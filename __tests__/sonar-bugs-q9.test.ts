/**
 * sonar-bugs-q9.test.ts — regression coverage for RQ-PLUGBUGS11Q8.
 *
 *   S6959 (reduce without an initial value — throws on empty arrays):
 *     - servers/_weekly-digest.ts  buildComparison best-item reduce, seeded
 *       with withQty[0]; the dead `withQty.length === 0` branch it sat behind
 *       was removed (every `eligible` item has unitCost <= dollars, so qty
 *       is always >= 1 and withQty === eligible there).
 *     - servers/_savings-render.ts monthly-rollup "best day" reduce, seeded
 *       with activeEntries[0] (parity with servers/efficiency-savings.ts).
 *     - scripts/embed-tune.ts      tune() best-threshold reduce, seeded with
 *       allStats[0].
 *     Empty-input cases are pinned below so the seeded reduces can never
 *     regress to the throw-on-empty form.
 *
 *   S6638 (constant binary expression):
 *     - scripts/genome-cloud-sync.ts `Number(delta.sourceSha) ?? 0` was dead
 *       code — Number() never returns nullish — and worse, a non-numeric
 *       sourceSha produced NaN, which `??` does NOT coalesce, so a bogus
 *       "NaN.json" section file could be written. Now `|| 0` so NaN and
 *       missing numbers both fall back to 0.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildComparison } from "../servers/_weekly-digest";
import { renderSavings } from "../servers/_savings-render";
import type { LifetimeBucket, SessionBucket } from "../servers/_stats";
import { tune, type CalibrationEntry } from "../scripts/embed-tune";
import {
  syncCloudDeltas,
  prsDir,
  issuesDir,
  type CloudDelta,
} from "../scripts/genome-cloud-sync";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sonar-q9-"));
  // Minimal genome scaffold so syncCloudDeltas doesn't bail "no-local-genome".
  mkdirSync(join(dir, ".ashlrcode", "genome"), { recursive: true });
  return dir;
}

function makeFetch(body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function delta(cursor: number, kind: CloudDelta["kind"], sourceSha: string, payload: unknown): CloudDelta {
  return {
    id: cursor,
    cursor,
    kind,
    sourceSha,
    recordedAt: "2026-10-30T12:00:00Z",
    payload,
  };
}

function calibEntry(topSimilarity: number, hit: boolean): CalibrationEntry {
  return {
    ts: new Date().toISOString(),
    queryHashHex: "deadbeef",
    topSimilarity,
    hit,
    contentLength: 500,
    threshold: 0.68,
  };
}

const quietSession: SessionBucket = {
  startedAt: new Date().toISOString(),
  lastSavingAt: null,
  calls: 0,
  tokensSaved: 0,
  byTool: {},
};

/** Render renderSavings() and slice out just the "last 30 days:" block. */
function monthlySection(byDay: LifetimeBucket["byDay"]): string {
  const lifetime: LifetimeBucket = { calls: 0, tokensSaved: 0, byTool: {}, byDay };
  return renderSavings(quietSession, lifetime)
    .split("last 30 days:\n")[1]!
    .split("\n\n")[0]!;
}

function dayEntry(offsetDays: number, entry: { calls: number; tokensSaved: number }) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return [d.toISOString().slice(0, 10), entry] as const;
}

// ---------------------------------------------------------------------------
// S6959 — buildComparison (servers/_weekly-digest.ts)
// ---------------------------------------------------------------------------

describe("buildComparison — seeded reduce, empty/degenerate inputs", () => {
  test("below the 0.01 floor → empty string, reduce never runs", () => {
    for (const dollars of [0, 0.004, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildComparison(dollars)).toBe("");
    }
  });

  test("single-candidate reduce input: $0.01 → the only eligible item", () => {
    // Only "minutes of GitHub Actions" (unitCost 0.008) is eligible; the
    // seeded reduce must still return it rather than throwing.
    expect(buildComparison(0.01)).toBe("1 minute of GitHub Actions");
  });

  test("exact picks stay stable", () => {
    expect(buildComparison(10)).toBe("7 song downloads");
    expect(buildComparison(37.2)).toBe("7 sandwiches");
    expect(buildComparison(50)).toBe("10 sandwiches");
  });

  test("sweep over all reduce input sizes never throws", () => {
    // Crossing minDollars thresholds grows `eligible` 1 → 9 items; each call
    // must produce a whole-number comparison.
    for (let cents = 1; cents <= 100_000; cents += 37) {
      const dollars = cents / 100;
      const out = buildComparison(dollars);
      if (dollars < 0.01) {
        expect(out).toBe("");
      } else {
        expect(out).toMatch(/^\d+ \S/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// S6959 — renderSavings monthly rollup (servers/_savings-render.ts)
// ---------------------------------------------------------------------------

describe("renderSavings — seeded best-day reduce", () => {
  test("no active days → history placeholder, reduce never runs", () => {
    expect(monthlySection({})).toContain("not enough history yet");
  });

  test("single active day → still below the 2-day bar", () => {
    const byDay = Object.fromEntries([dayEntry(3, { calls: 4, tokensSaved: 900 })]);
    expect(monthlySection(byDay)).toContain("not enough history yet");
  });

  test("two active days → totals plus best-day line", () => {
    const byDay = Object.fromEntries([
      dayEntry(5, { calls: 3, tokensSaved: 500 }),
      dayEntry(2, { calls: 7, tokensSaved: 1_500 }),
    ]);
    const section = monthlySection(byDay);
    expect(section).toContain("calls     10");
    expect(section).toContain("saved     2,000 tok");
    const best = /best day\s+(\d{4}-\d{2}-\d{2})/.exec(section);
    expect(best).not.toBeNull();
    // The larger day (2 days ago) must win.
    expect(best![1]).toBe(dayEntry(2, { calls: 0, tokensSaved: 0 })[0]);
  });

  test("tied maxima keep the first day in window order", () => {
    const byDay = Object.fromEntries([
      dayEntry(6, { calls: 1, tokensSaved: 800 }),
      dayEntry(4, { calls: 2, tokensSaved: 800 }),
      dayEntry(1, { calls: 5, tokensSaved: 400 }),
    ]);
    const best = /best day\s+(\d{4}-\d{2}-\d{2})/.exec(monthlySection(byDay));
    expect(best).not.toBeNull();
    // Strict `>` comparator: the earliest of the tied maxima wins.
    expect(best![1]).toBe(dayEntry(6, { calls: 0, tokensSaved: 0 })[0]);
  });
});

// ---------------------------------------------------------------------------
// S6959 — tune() best-threshold reduce (scripts/embed-tune.ts)
// ---------------------------------------------------------------------------

describe("tune — seeded best-threshold reduce", () => {
  test("empty entries → still returns a finite recommendation", () => {
    const result = tune([], 0.68, 1.0);
    expect(result.entryCount).toBe(0);
    expect(result.recommendedStats.fBeta).toBe(0);
    // Every swept threshold scores fBeta 0, so the seeded first step wins.
    expect(result.recommendedThreshold).toBeCloseTo(0.5, 2);
  });

  test("reduce still moves past the seed when a later threshold wins", () => {
    // At thresholds <= 0.60 both entries "would hit" → precision 0.5.
    // At thresholds in (0.60, 0.90] only the true hit remains → fBeta 1.
    const entries = [calibEntry(0.9, true), calibEntry(0.6, false)];
    const result = tune(entries, 0.68, 1.0);
    expect(result.recommendedThreshold).toBeCloseTo(0.61, 2);
    expect(result.recommendedStats.fBeta).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S6638 — writePrSection/writeIssueSection (scripts/genome-cloud-sync.ts)
// ---------------------------------------------------------------------------

describe("syncCloudDeltas — numeric fallback for section ids", () => {
  async function sync(deltas: CloudDelta[], repo: string) {
    return syncCloudDeltas({
      tier: "pro",
      cwd: repo,
      home: repo,
      fetchFn: makeFetch({ deltas, nextCursor: 99 }),
      genomeId: "g1",
      proToken: "tok",
    });
  }

  test("non-numeric sourceSha falls back to 0, never writes NaN.json", async () => {
    const repo = makeTmpRepo();
    try {
      const res = await sync(
        [
          delta(1, "pr_merged", "abcdef1234-not-a-number", { title: "PR with sha source" }),
          delta(2, "issue_closed", "9f8e7d6c5b", { title: "Issue with sha source" }),
        ],
        repo,
      );
      expect(res.written).toBe(2);
      expect(existsSync(join(prsDir(repo), "0.json"))).toBe(true);
      expect(existsSync(join(issuesDir(repo), "0.json"))).toBe(true);
      expect(existsSync(join(prsDir(repo), "NaN.json"))).toBe(false);
      expect(existsSync(join(issuesDir(repo), "NaN.json"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("numeric sourceSha is used when payload.number is absent", async () => {
    const repo = makeTmpRepo();
    try {
      const res = await sync([delta(1, "pr_merged", "77", { title: "sha-as-number" })], repo);
      expect(res.written).toBe(1);
      const file = join(prsDir(repo), "77.json");
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf-8")).id).toBe("77");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("payload.number still wins over sourceSha", async () => {
    const repo = makeTmpRepo();
    try {
      const res = await sync(
        [delta(1, "pr_merged", "55", { number: 42, title: "real PR" })],
        repo,
      );
      expect(res.written).toBe(1);
      expect(existsSync(join(prsDir(repo), "42.json"))).toBe(true);
      expect(existsSync(join(prsDir(repo), "55.json"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
