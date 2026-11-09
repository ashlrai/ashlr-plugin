/**
 * check-tier.test.ts — tests for the tier-reporting helper.
 *
 * scripts/check-tier.ts prints one token (free/pro/team) that genome-cloud
 * sync and selftest branch on, and its documented contract is "always exits
 * 0, callers can trust the output token". These tests pin every branch of
 * the ~/.ashlr/pro-token-cache.json read: missing, corrupt, unvalidated,
 * stale beyond the 7-day offline grace, and each plan value.
 *
 * Hermetic: the script runs as a subprocess against a mkdtemp HOME.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runWithCache(cache: string | null): { stdout: string; exitCode: number } {
  const home = mkdtempSync(join(tmpdir(), "ashlr-check-tier-"));
  dirs.push(home);
  if (cache !== null) {
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    writeFileSync(join(home, ".ashlr", "pro-token-cache.json"), cache);
  }
  const script = resolve(__dirname, "..", "scripts", "check-tier.ts");
  const result = Bun.spawnSync([process.execPath, script], { env: { ...process.env, HOME: home } });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const cache = (overrides: Record<string, unknown>) => JSON.stringify({
  valid: true,
  validatedAt: new Date(Date.now() - DAY_MS).toISOString(),
  plan: "pro",
  ...overrides,
});

describe("check-tier", () => {
  test("no cache file reports free and exits 0", () => {
    expect(runWithCache(null)).toMatchObject({ stdout: "free", exitCode: 0 });
  });

  test("a corrupt cache reports free, not a crash", () => {
    expect(runWithCache("{ nope")).toMatchObject({ stdout: "free", exitCode: 0 });
  });

  test("a fresh valid pro cache reports pro", () => {
    expect(runWithCache(cache({}))).toMatchObject({ stdout: "pro", exitCode: 0 });
  });

  test("a fresh valid team cache reports team", () => {
    expect(runWithCache(cache({ plan: "team" }))).toMatchObject({ stdout: "team", exitCode: 0 });
  });

  test("an invalid or planless cache reports free", () => {
    expect(runWithCache(cache({ valid: false }))).toMatchObject({ stdout: "free", exitCode: 0 });
    expect(runWithCache(cache({ plan: "free" }))).toMatchObject({ stdout: "free", exitCode: 0 });
    expect(runWithCache(cache({ plan: undefined }))).toMatchObject({ stdout: "free", exitCode: 0 });
  });

  test("a cache older than the 7-day offline grace reports free", () => {
    expect(runWithCache(cache({ validatedAt: new Date(Date.now() - 8 * DAY_MS).toISOString() })))
      .toMatchObject({ stdout: "free", exitCode: 0 });
    // One day short of the grace window still counts.
    expect(runWithCache(cache({ validatedAt: new Date(Date.now() - 6 * DAY_MS).toISOString() })))
      .toMatchObject({ stdout: "pro", exitCode: 0 });
  });

  test("an unparseable validatedAt is treated as stale, not valid", () => {
    expect(runWithCache(cache({ validatedAt: "yesterday" }))).toMatchObject({ stdout: "free", exitCode: 0 });
  });
});
