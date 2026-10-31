import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetReadCache, buildStatusLine } from "../scripts/savings-status-line";

const doc = readFileSync(join(import.meta.dir, "../docs/status-line-fields-q8.md"), "utf8");
// Check the field table itself, not incidental mentions elsewhere in the document.
const rows = doc.split("\n").filter((line) => line.startsWith("| `"));
const now = Date.parse("2025-01-01T12:00:00Z");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "status-doc-"));
  mkdirSync(join(home, ".ashlr"));
  mkdirSync(join(home, ".claude"));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function write(path: string, value: unknown) {
  writeFileSync(join(home, path), JSON.stringify(value));
  _resetReadCache();
}

function render(overrides: Parameters<typeof buildStatusLine>[0] = {}) {
  return buildStatusLine({
    home, now, budget: 500, tipSeed: 0,
    env: { NO_COLOR: "1", ASHLR_STATUS_ANIMATE: "0", CLAUDE_SESSION_ID: "doc-test" },
    suppressNudgeTelemetry: true, suppressMilestoneSideEffects: true,
    ...overrides,
  }).replace(/\x1b\[[0-9;]*m/g, "");
}

// Each entry names one table row and a marker emitted by the renderer.
// Grouping related variants in a row permits prose edits without hiding a removed field.
const fields = [
  ["ashlr", "`ashlr`"], ["7d ", "`· 7d "], ["ctx: 50%", "`ctx: 50%`"],
  ["session ↑+12.3K", "`session ↑+12.3K`"], ["≈$", "`≈$0.01`"],
  ["lifetime +1.2M (est.)", "`lifetime +1.2M (est.)`"],
  ["* 3d streak", "`* 3d streak`"], ["☁ 2 machines", "`☁ 2 machines`"],
  ["brief: concise", "`brief: concise`"],
  ["last: ashlr__read +5.0K [2s ago]", "`last: ashlr__read +5.0K [2s ago]`"],
  ["tip:", "`tip: use /ashlr-savings to see totals`"],
  ["↑:", "`↑: 50k+ saved — try Pro (7d trial /ashlr-upgrade)`"],
] as const;

describe("status line field documentation", () => {
  test.each(fields)("documents emitted field %s in the field table", (_output, example) => {
    expect(rows.some((row) => row.includes(example))).toBe(true);
  });

  test("representative output exercises the documented fields and variants", () => {
    write(".ashlr/stats.json", {
      sessions: { "doc-test": { tokensSaved: 12300, lastSavingAt: new Date(now - 2000).toISOString(), byTool: { ashlr__read: { tokensSaved: 5000 } } } },
      lifetime: { calls: 20, tokensSaved: 1200000 },
    });
    write(".ashlr/streaks.json", { currentStreak: 3, longestStreak: 3, lastActiveDay: "2025-01-01" });
    write(".ashlr/brief.json", { level: "concise" });
    const line = render({ statusLineInput: { context_used_tokens: 50, context_limit_tokens: 100 } });
    for (const marker of ["ashlr", "7d ", "ctx: 50%", "session ++12.3K", "≈$", "lifetime +1.2M (est.)", "* 3d streak", "brief: concise", "last: ashlr__read +5.0K [2s ago]", "tip:"]) {
      expect(line).toContain(marker);
    }
    write(".ashlr/stats.json", { sessions: { "doc-test": { tokensSaved: 50000 } }, lifetime: { calls: 20, tokensSaved: 50000 } });
    expect(render()).toContain("↑: 50k+ saved");
  });

  test("waiting, collecting, and measured variants are documented where they are described", () => {
    const sessionRow = rows.find((row) => row.includes("`session ↑+12.3K`")) ?? "";
    const lifetimeRow = rows.find((row) => row.includes("`lifetime +1.2M (est.)`")) ?? "";
    expect(render()).toContain("(waiting for first tool call)");
    expect(sessionRow).toContain("(waiting for first tool call)");
    write(".ashlr/stats.json", { lifetime: { calls: 1, tokensSaved: 0 } });
    expect(render()).toContain("session +0 (collecting…)");
    expect(sessionRow).toContain("session +0 (collecting…)");
    write(".ashlr/stats.json", { lifetime: { calls: 10, measuredCalls: 10, tokensSavedMeasured: 1000 } });
    expect(render()).toContain("(API-measured)");
    expect(lifetimeRow).toContain("(API-measured)");
  });
});
