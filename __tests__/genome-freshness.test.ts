/**
 * Tests for _genome-freshness — the Q2 prep freshness-badge surface.
 *
 * Covers:
 *   - formatFreshness bucket boundaries (1h / 24h / 7d / 30d) + undefined
 *   - loadSectionFreshnessMap (v2 manifest → path → lastUpdatedAt lookup)
 *   - decorateGenomeOutputWithFreshness (injects badges into the
 *     formatGenomeForPrompt header line)
 *   - End-to-end retrieveCommitSections + formatCommitsForPrompt round-trip:
 *     mixed-age commits get badged headers, legacy v1 sections do not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  decorateGenomeOutputWithFreshness,
  formatFreshness,
  loadSectionFreshnessMap,
} from "../servers/_genome-freshness";
import { saveManifestV2, type GenomeManifestV2 } from "../servers/_manifest-v2";
import {
  formatCommitsForPrompt,
  retrieveCommitSections,
} from "../servers/_genome-commits";
import { addCommitSection } from "../scripts/genome-commit-watcher";

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ago(ms: number, ref: Date = new Date()): string {
  return new Date(ref.getTime() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// formatFreshness — bucket boundaries
// ---------------------------------------------------------------------------

describe("formatFreshness — bucket boundaries", () => {
  const now = new Date("2026-05-22T12:00:00.000Z");

  test("undefined → empty string", () => {
    expect(formatFreshness(undefined, now)).toBe("");
  });

  test("unparseable timestamp → empty string", () => {
    expect(formatFreshness("not-a-date", now)).toBe("");
  });

  test("0 ms ago → [fresh]", () => {
    expect(formatFreshness(ago(0, now), now)).toBe("[fresh]");
  });

  test("just under 1h → [fresh]", () => {
    expect(formatFreshness(ago(HOUR - 1, now), now)).toBe("[fresh]");
  });

  test("exactly 1h → [fresh: 1h]", () => {
    expect(formatFreshness(ago(HOUR, now), now)).toBe("[fresh: 1h]");
  });

  test("3h → [fresh: 3h]", () => {
    expect(formatFreshness(ago(3 * HOUR, now), now)).toBe("[fresh: 3h]");
  });

  test("just under 24h → [fresh: 23h]", () => {
    expect(formatFreshness(ago(DAY - 1, now), now)).toBe("[fresh: 23h]");
  });

  test("exactly 24h → [fresh: 1d]", () => {
    expect(formatFreshness(ago(DAY, now), now)).toBe("[fresh: 1d]");
  });

  test("3d → [fresh: 3d]", () => {
    expect(formatFreshness(ago(3 * DAY, now), now)).toBe("[fresh: 3d]");
  });

  test("just under 7d → [fresh: 6d]", () => {
    expect(formatFreshness(ago(7 * DAY - 1, now), now)).toBe("[fresh: 6d]");
  });

  test("exactly 7d → [stale: 7d]", () => {
    expect(formatFreshness(ago(7 * DAY, now), now)).toBe("[stale: 7d]");
  });

  test("15d → [stale: 15d]", () => {
    expect(formatFreshness(ago(15 * DAY, now), now)).toBe("[stale: 15d]");
  });

  test("just under 30d → [stale: 29d]", () => {
    expect(formatFreshness(ago(30 * DAY - 1, now), now)).toBe("[stale: 29d]");
  });

  test("exactly 30d → [stale: >=30d]", () => {
    expect(formatFreshness(ago(30 * DAY, now), now)).toBe("[stale: >=30d]");
  });

  test("100d → [stale: >=30d] (clamps)", () => {
    expect(formatFreshness(ago(100 * DAY, now), now)).toBe("[stale: >=30d]");
  });

  test("future timestamp → [fresh] (defensive)", () => {
    expect(formatFreshness(ago(-HOUR, now), now)).toBe("[fresh]");
  });

  test("badge length stays ≤ 15 chars in every bucket", () => {
    const samples = [
      formatFreshness(ago(0, now), now),
      formatFreshness(ago(HOUR, now), now),
      formatFreshness(ago(23 * HOUR, now), now),
      formatFreshness(ago(6 * DAY, now), now),
      formatFreshness(ago(29 * DAY, now), now),
      formatFreshness(ago(365 * DAY, now), now),
    ];
    for (const s of samples) {
      expect(s.length).toBeLessThanOrEqual(15);
    }
  });
});

// ---------------------------------------------------------------------------
// loadSectionFreshnessMap — manifest → lookup
// ---------------------------------------------------------------------------

describe("loadSectionFreshnessMap", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ashlr-freshness-"));
    mkdirSync(join(projectDir, ".ashlrcode", "genome"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("returns empty map when no genome exists", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ashlr-no-genome-"));
    try {
      const map = await loadSectionFreshnessMap(empty);
      expect(map.size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("loads lastUpdatedAt from each v2 section", async () => {
    const manifest: GenomeManifestV2 = {
      version: 1,
      schemaVersion: 2,
      project: "fixture",
      sections: [
        {
          path: "vision/north-star.md",
          title: "North Star",
          summary: "x",
          tags: [],
          tokens: 10,
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUpdatedAt: "2026-05-22T10:00:00.000Z",
          sourceTrust: "static",
          kind: "static",
        },
        {
          path: "knowledge/decisions.md",
          title: "Decisions",
          summary: "y",
          tags: [],
          tokens: 10,
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUpdatedAt: "2026-04-01T00:00:00.000Z",
          sourceTrust: "static",
          kind: "static",
        },
      ],
      generation: { number: 1, milestone: "x", startedAt: "2026-01-01T00:00:00.000Z" },
      fitnessHistory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await saveManifestV2(projectDir, manifest);

    const map = await loadSectionFreshnessMap(projectDir);
    expect(map.get("vision/north-star.md")).toBe("2026-05-22T10:00:00.000Z");
    expect(map.get("knowledge/decisions.md")).toBe("2026-04-01T00:00:00.000Z");
  });

  test("v1 manifest (no schemaVersion) auto-upgrades — lastUpdatedAt defaults to updatedAt", async () => {
    // Write raw v1 directly to disk so we exercise the upgrade path inside
    // loadManifestV2 instead of the saveManifestV2 default.
    const v1 = {
      version: 1,
      project: "fixture",
      sections: [
        {
          path: "legacy.md",
          title: "Legacy",
          summary: "z",
          tags: [],
          tokens: 5,
          updatedAt: "2026-01-15T00:00:00.000Z",
        },
      ],
      generation: { number: 1, milestone: "x", startedAt: "2026-01-01T00:00:00.000Z" },
      fitnessHistory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      join(projectDir, ".ashlrcode", "genome", "manifest.json"),
      JSON.stringify(v1, null, 2),
      "utf-8",
    );
    const map = await loadSectionFreshnessMap(projectDir);
    // Upgrade backfills lastUpdatedAt ← updatedAt, so legacy sections DO
    // get a badge once they're routed through the v2 loader. This is the
    // intended behavior — the safety net is sections that genuinely lack
    // a timestamp, which we test below in the decorate suite.
    expect(map.get("legacy.md")).toBe("2026-01-15T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// decorateGenomeOutputWithFreshness
// ---------------------------------------------------------------------------

describe("decorateGenomeOutputWithFreshness", () => {
  const now = new Date("2026-05-22T12:00:00.000Z");

  test("appends badge to matching section headers, leaves others alone", () => {
    const formatted = [
      "## Project Genome",
      "",
      "### North Star (vision/north-star.md)",
      "body of north star",
      "",
      "---",
      "",
      "### Legacy Doc (legacy.md)",
      "body of legacy",
    ].join("\n");
    const map = new Map<string, string>([
      ["vision/north-star.md", ago(3 * HOUR, now)],
      // legacy.md intentionally omitted — exercise the "no badge" path.
    ]);
    const out = decorateGenomeOutputWithFreshness(formatted, map, now);
    expect(out).toContain("### North Star (vision/north-star.md) [fresh: 3h]");
    // Legacy header untouched.
    expect(out).toContain("### Legacy Doc (legacy.md)\n");
    expect(out).not.toContain("legacy.md) [");
  });

  test("empty input or empty map → unchanged", () => {
    expect(decorateGenomeOutputWithFreshness("", new Map(), now)).toBe("");
    const f = "### x (x.md)\nbody";
    expect(decorateGenomeOutputWithFreshness(f, new Map(), now)).toBe(f);
  });

  test("idempotent — running twice does not double-badge", () => {
    const formatted = "### Title (a.md)\nbody";
    const map = new Map([["a.md", ago(2 * DAY, now)]]);
    const once = decorateGenomeOutputWithFreshness(formatted, map, now);
    const twice = decorateGenomeOutputWithFreshness(once, map, now);
    expect(twice).toBe(once);
    // sanity: one badge, not two
    expect((twice.match(/\[fresh: 2d\]/g) ?? []).length).toBe(1);
  });

  test("sections without lastUpdatedAt in the map emit no badge", () => {
    const formatted = "### Title (a.md)\nbody";
    const out = decorateGenomeOutputWithFreshness(formatted, new Map(), now);
    expect(out).toBe(formatted);
  });
});

// ---------------------------------------------------------------------------
// Commit-formatter integration (mixed-age + legacy paths)
// ---------------------------------------------------------------------------

describe("formatCommitsForPrompt — freshness badges on commit headers", () => {
  let projectDir: string;
  const now = new Date("2026-05-22T12:00:00.000Z");

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ashlr-fresh-commits-"));
    mkdirSync(join(projectDir, ".ashlrcode", "genome"), { recursive: true });

    // Minimal v1 manifest so addCommitSection can upgrade in place.
    writeFileSync(
      join(projectDir, ".ashlrcode", "genome", "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          project: "fixture",
          sections: [],
          generation: { number: 1, milestone: "x", startedAt: "2026-01-01T00:00:00.000Z" },
          fitnessHistory: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("mixed-age commits produce expected badges in the header", async () => {
    // Fresh commit (2h old).
    await addCommitSection(projectDir, {
      sha: "a".repeat(40),
      message: "feat: add manifest schema",
      author: "Tester <t@t.com>",
      date: ago(2 * HOUR, now),
      filesChanged: ["servers/_manifest-v2.ts"],
      summary: "# feat: add manifest schema\n\nintroduces v2.",
    });
    // Stale commit (10d old).
    await addCommitSection(projectDir, {
      sha: "b".repeat(40),
      message: "feat: schema introspection helper",
      author: "Tester <t@t.com>",
      date: ago(10 * DAY, now),
      filesChanged: ["servers/_manifest-v2.ts"],
      summary: "# feat: schema introspection helper\n\nhelper for v2.",
    });

    const hits = await retrieveCommitSections(projectDir, "manifest schema", 5);
    expect(hits.length).toBe(2);
    // Force lastUpdatedAt onto each retrieved commit to match the commit
    // date for assertion stability — addCommitSection stamps lastUpdatedAt
    // at write time, which is "right now" in the test, not the commit date.
    const decoratedHits = hits.map((h) => ({
      ...h,
      lastUpdatedAt:
        h.sha.startsWith("a") ? ago(2 * HOUR, now) : ago(10 * DAY, now),
    }));

    const out = formatCommitsForPrompt(decoratedHits, now);
    expect(out).toContain("Commit History");
    // Fresh entry — header carries the 2h badge fragment.
    expect(out).toMatch(/\[commit a{7} - \S+ · fresh: 2h\]/);
    // Stale entry — header carries the 10d badge fragment.
    expect(out).toMatch(/\[commit b{7} - \S+ · stale: 10d\]/);
  });

  test("commits without lastUpdatedAt render the original header (legacy safety)", () => {
    const out = formatCommitsForPrompt(
      [
        {
          sha: "c".repeat(40),
          shortSha: "ccccccc",
          date: "2026-05-22T00:00:00.000Z",
          message: "fix: legacy commit",
          summary: "legacy",
          filesChanged: [],
          score: 1,
          // lastUpdatedAt deliberately omitted
        },
      ],
      now,
    );
    expect(out).toContain("[commit ccccccc - 2026-05-22] fix: legacy commit");
    // No badge sigil for the legacy path.
    expect(out).not.toContain("·");
  });
});
