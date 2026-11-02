import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Minimum versions that clear the open Dependabot critical/high alerts on the
// leaderboard eval pins. A lower pin reintroduces the alert, so keep these
// floors in step with the advisories rather than with whatever is installed.
const MINIMUM_PINS: Record<string, string> = {
  anyio: "4.14.2",
  certifi: "2026.10.18",
  mcp: "1.28.1",
};

const REQUIREMENTS = fileURLToPath(new URL("../eval/leaderboard/requirements.txt", import.meta.url));

// Parses `name==version` lines, ignoring blanks and comments. Unpinned or
// range specifiers (`>=`, `~=`, bare names) are returned as-is so the caller
// can reject them instead of silently skipping the package.
function parsePins(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9._-]+)==([A-Za-z0-9.+-]+)$/.exec(line);
    if (!match) throw new Error(`unparseable requirement line: ${line}`);
    pins.set(match[1]!.toLowerCase(), match[2]!);
  }
  return pins;
}

// Compares dotted numeric versions (4.14.2, 2026.10.18). Returns negative,
// zero or positive like a sort comparator. Non-numeric segments fail loudly.
function compareVersions(a: string, b: string): number {
  const toParts = (v: string) =>
    v.split(".").map((part) => {
      if (!/^\d+$/.test(part)) throw new Error(`non-numeric version segment in ${v}`);
      return Number(part);
    });
  const pa = toParts(a);
  const pb = toParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe("eval/leaderboard requirements pins", () => {
  const pins = parsePins(readFileSync(REQUIREMENTS, "utf8"));

  for (const [name, minimum] of Object.entries(MINIMUM_PINS)) {
    test(`${name} is pinned at or above ${minimum}`, () => {
      const pinned = pins.get(name);
      expect(pinned, `${name} must be pinned with ==`).toBeDefined();
      expect(compareVersions(pinned!, minimum)).toBeGreaterThanOrEqual(0);
    });
  }

  test("version comparison orders dotted and date-style versions", () => {
    expect(compareVersions("4.13.0", "4.14.2")).toBeLessThan(0);
    expect(compareVersions("4.14.2", "4.14.2")).toBe(0);
    expect(compareVersions("1.28.1", "1.27.2")).toBeGreaterThan(0);
    expect(compareVersions("2026.5.20", "2026.10.18")).toBeLessThan(0);
    expect(compareVersions("1.28", "1.28.0")).toBe(0);
  });
});
