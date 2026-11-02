/**
 * Validates that eval/leaderboard/requirements.txt pins anyio, certifi, and mcp
 * at or above their Dependabot-patched versions.
 *
 * Patched versions (from the Dependabot advisory):
 *   anyio  >= 4.14.2  (critical)
 *   certifi >= 2026.10.18 (critical)
 *   mcp    >= 1.30.0  (high / medium)
 *
 * The test FAILS when a pin is below the patched threshold.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REQS_PATH = join(__dirname, "..", "eval", "leaderboard", "requirements.txt");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a pip requirements file and return a map of package name -> version.
 * Only considers lines that are pinned with == and skips blanks/comments.
 */
function parseRequirements(path: string): Record<string, string> {
  const lines = readFileSync(path, "utf-8").split("\n");
  const pins: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("==");
    if (idx === -1) continue;
    pins[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 2).trim();
  }
  return pins;
}

/**
 * Compare two version strings semver-style (handles dotted decimals).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("eval-pin-floor", () => {
  test("anyio is pinned at or above 4.14.2 (patched)", () => {
    const pins = parseRequirements(REQS_PATH);
    expect(pins).toHaveProperty("anyio");
    expect(
      compareVersions(pins.anyio, "4.14.2"),
      `anyio ${pins.anyio} is below the patched version 4.14.2`,
    ).toBeGreaterThanOrEqual(0);
  });

  test("certifi is pinned at or above 2026.10.18 (patched)", () => {
    const pins = parseRequirements(REQS_PATH);
    expect(pins).toHaveProperty("certifi");
    expect(
      compareVersions(pins.certifi, "2026.10.18"),
      `certifi ${pins.certifi} is below the patched version 2026.10.18`,
    ).toBeGreaterThanOrEqual(0);
  });

  test("mcp is pinned at or above 1.30.0 (patched)", () => {
    const pins = parseRequirements(REQS_PATH);
    expect(pins).toHaveProperty("mcp");
    expect(
      compareVersions(pins.mcp, "1.30.0"),
      `mcp ${pins.mcp} is below the patched version 1.30.0`,
    ).toBeGreaterThanOrEqual(0);
  });

  test("all three pinned packages exist simultaneously", () => {
    const pins = parseRequirements(REQS_PATH);
    const keys = ["anyio", "certifi", "mcp"];
    for (const key of keys) {
      expect(pins).toHaveProperty(key);
    }
  });
});
