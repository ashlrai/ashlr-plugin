import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  compactReadContent, fmtCost, formatAge, isCodeFile, numberCodeLines,
  renderToolAndDaySections, resolveRg,
} from "../servers/_efficiency-shared";
import { renderSavings as legacyReport } from "../servers/efficiency-savings";
import { renderSavings as currentReport } from "../servers/_savings-render";
import type { LifetimeBucket, SessionBucket } from "../servers/_stats";

const session: SessionBucket = {
  startedAt: "2026-01-01T00:00:00Z", lastSavingAt: null,
  calls: 0, tokensSaved: 0, byTool: {},
};
const lifetime: LifetimeBucket = { calls: 0, tokensSaved: 0, byTool: {}, byDay: {} };
afterEach(() => setSystemTime());

describe("shared efficiency read formatting", () => {
  test.each(["file.TS", "file.tsx", "file.py", "file.rs", "file.svelte"])("recognizes code: %s", (path) => {
    expect(isCodeFile(path)).toBe(true);
  });
  test.each(["README", "file.txt", "file.ts.bak", "file.ts/child"])("leaves other paths unnumbered: %s", (path) => {
    expect(isCodeFile(path)).toBe(false);
  });
  test("keeps blank lines, CRLFs, and padding across a digit boundary", () => {
    expect(numberCodeLines("")).toBe("1: ");
    expect(numberCodeLines("a\r\n\nb")).toBe("1: a\r\n2: \n3: b");
    const lines = numberCodeLines("x\n".repeat(9)).split("\n");
    expect(lines[0]).toBe(" 1: x");
    expect(lines[9]).toBe("10: ");
  });
  test("leaves short content intact and preserves numbered head/tail when snipping", () => {
    expect(compactReadContent("")).toBe("");
    expect(compactReadContent("1: hello\n2: ")).toBe("1: hello\n2: ");
    const source = numberCodeLines(Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n"));
    const compact = compactReadContent(source);
    expect(compact.length).toBeLessThan(source.length);
    expect(compact).toContain("[... truncated ...]");
    expect(compact.startsWith("  1: const line0 = 0;")).toBe(true);
    expect(compact.endsWith("400: const line399 = 399;")).toBe(true);
  });
});

describe("shared efficiency savings sections", () => {
  test("uses UTC calendar windows and suppresses a monthly rollup with one active day", () => {
    setSystemTime(new Date("2026-01-01T00:30:00Z"));
    const lines = renderToolAndDaySections(session, { ...lifetime, byDay: { "2026-01-01": { calls: 1, tokensSaved: 0 } } });
    expect(lines.slice(0, 4)).toEqual(["by tool (session):", "  (no calls yet this session)", "", "last 7 days:"]);
    expect(lines.slice(4, 11).map((line) => line.trim().slice(0, 5))).toEqual(["12-26", "12-27", "12-28", "12-29", "12-30", "12-31", "01-01"]);
    expect(lines.filter((line) => line.includes("(quiet)"))).toHaveLength(7);
    expect(lines.at(-1)).toBe("  (not enough history yet — come back in a few weeks)");
  });
  test("sorts tools, excludes inactive days/tools, and keeps the earliest tied best day", () => {
    setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const active = { ...session, byTool: { read: { calls: 1, tokensSaved: 100 }, grep: { calls: 2, tokensSaved: 200 }, idle: { calls: 0, tokensSaved: 0 } } };
    const history = { ...lifetime, byDay: {
      "2025-12-02": { calls: 99, tokensSaved: 9999 }, // outside the 30-day window
      "2025-12-03": { calls: 2, tokensSaved: 200 },
      "2025-12-31": { calls: 1, tokensSaved: 200 },
      "2026-01-01": { calls: 0, tokensSaved: 0 },
    } };
    const lines = renderToolAndDaySections(active, history);
    expect(lines[1]).toContain("grep");
    expect(lines[1]).toContain("67%");
    expect(lines[2]).toContain("read");
    expect(lines.join("\n")).not.toContain("idle");
    expect(lines.slice(-3)).toEqual(["  calls     3", `  saved     400 tok   ${fmtCost(400)}`, "  best day  2025-12-03    ·  200 tok   ·  2 calls"]);
    const section = lines.join("\n");
    expect(legacyReport(active, history)).toContain(section);
    expect(currentReport(active, history)).toContain(section);
  });
  test("retains zero-token active days and avoids division by zero", () => {
    setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const lines = renderToolAndDaySections({ ...session, byTool: { read: { calls: 1, tokensSaved: 0 } } }, {
      ...lifetime, byDay: { "2025-12-31": { calls: 1, tokensSaved: 0 }, "2026-01-01": { calls: 2, tokensSaved: 0 } },
    });
    expect(lines[1]).toContain("0%");
    expect(lines.at(-1)).toBe("  best day  2025-12-31    ·  0 tok   ·  1 call");
  });
  test("formats age boundaries, future timestamps, and invalid dates", () => {
    setSystemTime(new Date("2026-01-01T12:00:00Z"));
    for (const [seconds, expected] of [[0, "0s ago"], [59, "59s ago"], [60, "1m ago"], [3600, "1h 0m ago"], [90000, "1d 1h ago"]] as const) {
      expect(formatAge(new Date(Date.now() - seconds * 1000).toISOString())).toBe(expected);
    }
    expect(formatAge("invalid")).toBe("just now");
    expect(formatAge("2026-01-02T00:00:00Z")).toBe("just now");
    expect(fmtCost(0)).toBe("≈ $0.0000");
  });
});

test("ripgrep resolution prefers Bun's executable lookup", () => {
  const which = spyOn(Bun, "which").mockReturnValue("/test/bin/rg");
  try {
    expect(resolveRg()).toBe("/test/bin/rg");
    expect(which).toHaveBeenCalledWith("rg");
  } finally {
    which.mockRestore();
  }
});
