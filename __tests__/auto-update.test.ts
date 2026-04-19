/**
 * Tests for the auto-update notifier in scripts/auto-update.ts.
 *
 * Six cases:
 *   1. Same version → no notice.
 *   2. Newer upstream → notice printed once.
 *   3. Already-notified-today → no duplicate.
 *   4. Network failure → silent.
 *   5. Malformed GitHub response → silent.
 *   6. Semver comparison: 1.9.0 < 1.10.0 < 1.10.1 < 2.0.0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  alreadyNotifiedToday,
  checkForUpdate,
  isNewerVersion,
  parseSemver,
  readUpdateStamp,
  writeUpdateStamp,
  type GitHubRelease,
} from "../scripts/auto-update";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-update-test-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
  test("parses bare semver", () => {
    expect(parseSemver("1.9.0")).toEqual([1, 9, 0]);
  });
  test("strips leading v", () => {
    expect(parseSemver("v2.0.0")).toEqual([2, 0, 0]);
  });
  test("handles pre-release suffix", () => {
    expect(parseSemver("1.10.0-rc.1")).toEqual([1, 10, 0]);
  });
  test("returns null for garbage", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isNewerVersion — test 6: semver ordering
// ---------------------------------------------------------------------------

describe("isNewerVersion — semver ordering", () => {
  test("1.9.0 < 1.10.0", () => {
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(true);
  });
  test("1.10.0 < 1.10.1", () => {
    expect(isNewerVersion("1.10.0", "1.10.1")).toBe(true);
  });
  test("1.10.1 < 2.0.0", () => {
    expect(isNewerVersion("1.10.1", "2.0.0")).toBe(true);
  });
  test("same version → not newer", () => {
    expect(isNewerVersion("1.9.0", "1.9.0")).toBe(false);
  });
  test("downstream is older → not newer", () => {
    expect(isNewerVersion("2.0.0", "1.9.0")).toBe(false);
  });
  test("minor version older → not newer", () => {
    expect(isNewerVersion("1.10.0", "1.9.9")).toBe(false);
  });
  test("malformed upstream → false", () => {
    expect(isNewerVersion("1.9.0", "not-semver")).toBe(false);
  });
  test("malformed current → false", () => {
    expect(isNewerVersion("bad", "1.10.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stamp helpers
// ---------------------------------------------------------------------------

describe("stamp helpers", () => {
  test("readUpdateStamp returns empty when file absent", () => {
    expect(readUpdateStamp(home)).toBe("");
  });

  test("writeUpdateStamp and readUpdateStamp round-trip", () => {
    writeUpdateStamp("1.10.0", home);
    const stamp = readUpdateStamp(home);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}\/1\.10\.0$/);
  });

  test("alreadyNotifiedToday returns true after writing today's stamp", () => {
    const today = "2026-04-18";
    writeUpdateStamp("1.10.0", home);
    // Override today to match what writeUpdateStamp wrote
    const stamp = readUpdateStamp(home);
    const writtenDate = stamp.split("/")[0]!;
    expect(alreadyNotifiedToday("1.10.0", home, writtenDate)).toBe(true);
  });

  test("alreadyNotifiedToday returns false for different version", () => {
    const today = "2026-04-18";
    writeUpdateStamp("1.10.0", home);
    expect(alreadyNotifiedToday("1.11.0", home, today)).toBe(false);
  });

  test("alreadyNotifiedToday returns false for different date", () => {
    writeUpdateStamp("1.10.0", home, "2026-04-18");
    expect(alreadyNotifiedToday("1.10.0", home, "2026-04-19")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate integration cases
// ---------------------------------------------------------------------------

function makeRelease(tag: string): GitHubRelease {
  return { tag_name: tag };
}

async function runCheck(opts: {
  currentVersion: string;
  fetchResult: GitHubRelease | null | "throw";
  home?: string;
  today?: string;
}): Promise<string[]> {
  const lines: string[] = [];
  const fetchFn = async (_repo: string): Promise<GitHubRelease | null> => {
    if (opts.fetchResult === "throw") throw new Error("network failure");
    return opts.fetchResult;
  };
  await checkForUpdate({
    currentVersion: opts.currentVersion,
    home: opts.home ?? home,
    today: opts.today ?? "2026-04-18",
    fetchFn,
    logger: (msg) => lines.push(msg),
  });
  return lines;
}

describe("checkForUpdate", () => {
  // Test 1: same version → no notice
  test("same version: no notice emitted", async () => {
    const lines = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: makeRelease("v1.9.0"),
    });
    expect(lines).toHaveLength(0);
  });

  // Test 2: newer upstream → notice printed once
  test("newer upstream: prints exactly one notice line", async () => {
    const lines = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: makeRelease("v1.10.0"),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("v1.10.0 available");
    expect(lines[0]).toContain("v1.9.0");
    expect(lines[0]).toContain("/ashlr-update");
  });

  // Test 3: already-notified-today → no duplicate
  test("already notified today: no duplicate notice", async () => {
    const today = "2026-04-18";
    // First call — should notify
    const first = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: makeRelease("v1.10.0"),
      today,
    });
    expect(first).toHaveLength(1);
    // Second call same day same version — should be silent
    const second = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: makeRelease("v1.10.0"),
      today,
    });
    expect(second).toHaveLength(0);
  });

  // Test 4: network failure → silent
  test("network failure: no output, no throw", async () => {
    const lines = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: "throw",
    });
    expect(lines).toHaveLength(0);
  });

  // Test 5: malformed GitHub response → silent
  test("malformed response (null): silent", async () => {
    const lines = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: null,
    });
    expect(lines).toHaveLength(0);
  });

  test("older upstream than current: no notice", async () => {
    const lines = await runCheck({
      currentVersion: "2.0.0",
      fetchResult: makeRelease("v1.9.0"),
    });
    expect(lines).toHaveLength(0);
  });

  test("new day resets gate: notifies again on subsequent day", async () => {
    const day1 = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: makeRelease("v1.10.0"),
      today: "2026-04-18",
    });
    expect(day1).toHaveLength(1);
    const day2 = await runCheck({
      currentVersion: "1.9.0",
      fetchResult: makeRelease("v1.10.0"),
      today: "2026-04-19",
    });
    expect(day2).toHaveLength(1);
  });
});
