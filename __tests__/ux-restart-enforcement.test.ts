/**
 * Tests for UX-audit cliff #2 — wizard restart enforcement + SessionStart
 * missed-restart detection.
 *
 * Coverage:
 *   1. Wizard end → writes ~/.ashlr/restart-required with correct shape
 *      (writtenAt + pid + wizardVersion).
 *   2. Wizard restart callout contains the verbatim "RESTART REQUIRED" block.
 *   3. SessionStart + stale hint (5min old) → file deleted, no warning.
 *   4. SessionStart + fresh hint + different pid → file deleted silently.
 *   5. SessionStart + fresh hint + same pid → warning printed, file NOT deleted.
 *   6. SessionStart + no hint file → no-op, no error.
 *
 * Uses mkdtempSync + HOME override so the real ~/.ashlr/restart-required is
 * never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  restartRequiredPath,
  writeRestartRequired,
  readPackageVersionSafe,
  renderRestartCallout,
} from "../scripts/onboarding-wizard";

import {
  checkMissedRestart,
  MISSED_RESTART_WARNING,
  RESTART_HINT_FRESHNESS_MS,
} from "../hooks/session-start";

let fakeHome: string;
const origEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "ashlr-restart-test-"));
  origEnv.ASHLR_HOME_OVERRIDE = process.env.ASHLR_HOME_OVERRIDE;
  process.env.ASHLR_HOME_OVERRIDE = fakeHome;
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
  if (origEnv.ASHLR_HOME_OVERRIDE === undefined) {
    delete process.env.ASHLR_HOME_OVERRIDE;
  } else {
    process.env.ASHLR_HOME_OVERRIDE = origEnv.ASHLR_HOME_OVERRIDE;
  }
});

// ---------------------------------------------------------------------------
// Wizard side: writeRestartRequired
// ---------------------------------------------------------------------------

describe("writeRestartRequired", () => {
  test("writes hint with writtenAt + pid + wizardVersion", () => {
    writeRestartRequired(fakeHome);
    const p = restartRequiredPath(fakeHome);
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    expect(typeof parsed.writtenAt).toBe("string");
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.wizardVersion).toBe("string");
    expect(parsed.wizardVersion.length).toBeGreaterThan(0);
    // writtenAt should parse to a valid date close to now
    const ageMs = Date.now() - Date.parse(parsed.writtenAt);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(5_000);
  });

  test("hint path is ~/.ashlr/restart-required", () => {
    expect(restartRequiredPath(fakeHome)).toBe(
      join(fakeHome, ".ashlr", "restart-required"),
    );
  });

  test("readPackageVersionSafe returns a non-empty version string", () => {
    const v = readPackageVersionSafe();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    // Either a real version or the documented "unknown" fallback
    expect(v === "unknown" || /^\d+\.\d+\.\d+/.test(v)).toBe(true);
  });

  test("idempotent — multiple writes overwrite, never error", () => {
    writeRestartRequired(fakeHome);
    writeRestartRequired(fakeHome);
    writeRestartRequired(fakeHome);
    const parsed = JSON.parse(readFileSync(restartRequiredPath(fakeHome), "utf-8"));
    expect(parsed.pid).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// Wizard side: renderRestartCallout prints the loud block
// ---------------------------------------------------------------------------

describe("renderRestartCallout", () => {
  test("prints 'RESTART REQUIRED' verbatim to stdout", () => {
    const orig = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      renderRestartCallout(fakeHome);
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain("RESTART REQUIRED");
    expect(captured).toContain(
      "your next tool call will NOT use ashlr until",
    );
    expect(captured).toContain("fully quit and reopen Claude Code");
    expect(captured).toContain(
      "built-in Read/Edit/Grep run instead and you'll see no savings.",
    );
  });

  test("side-effect: writes the restart-required hint file", () => {
    // Silence stdout while we run the callout
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      renderRestartCallout(fakeHome);
    } finally {
      process.stdout.write = orig;
    }
    expect(existsSync(restartRequiredPath(fakeHome))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SessionStart side: checkMissedRestart
// ---------------------------------------------------------------------------

function writeHint(
  home: string,
  payload: { writtenAt: string; pid: number; wizardVersion?: string },
): void {
  mkdirSync(join(home, ".ashlr"), { recursive: true });
  writeFileSync(
    restartRequiredPath(home),
    JSON.stringify({ wizardVersion: "test", ...payload }, null, 2),
  );
}

describe("checkMissedRestart", () => {
  test("no hint file → no-op, no warning, no error", () => {
    let stderr = "";
    const result = checkMissedRestart({
      home: fakeHome,
      stderr: (m) => { stderr += m; },
    });
    expect(result.outcome).toBe("no-hint");
    expect(result.warning).toBeNull();
    expect(result.cleared).toBe(false);
    expect(stderr).toBe("");
  });

  test("stale hint (5 minutes old) → file deleted, no warning", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    writeHint(fakeHome, { writtenAt: fiveMinAgo, pid: process.pid });

    let stderr = "";
    const result = checkMissedRestart({
      home: fakeHome,
      stderr: (m) => { stderr += m; },
    });
    expect(result.outcome).toBe("stale");
    expect(result.cleared).toBe(true);
    expect(result.warning).toBeNull();
    expect(stderr).toBe("");
    expect(existsSync(restartRequiredPath(fakeHome))).toBe(false);
  });

  test("fresh hint with DIFFERENT pid → file deleted silently", () => {
    const justNow = new Date().toISOString();
    // pid = ours + 1 so it never collides
    const otherPid = process.pid + 1;
    writeHint(fakeHome, { writtenAt: justNow, pid: otherPid });

    let stderr = "";
    const result = checkMissedRestart({
      home: fakeHome,
      stderr: (m) => { stderr += m; },
    });
    expect(result.outcome).toBe("restarted");
    expect(result.cleared).toBe(true);
    expect(result.warning).toBeNull();
    expect(stderr).toBe("");
    expect(existsSync(restartRequiredPath(fakeHome))).toBe(false);
  });

  test("fresh hint with SAME pid → warning printed, file NOT deleted", () => {
    const justNow = new Date().toISOString();
    writeHint(fakeHome, { writtenAt: justNow, pid: process.pid });

    let stderr = "";
    const result = checkMissedRestart({
      home: fakeHome,
      stderr: (m) => { stderr += m; },
    });
    expect(result.outcome).toBe("missed");
    expect(result.cleared).toBe(false);
    expect(result.warning).toBe(MISSED_RESTART_WARNING);
    expect(stderr).toBe(MISSED_RESTART_WARNING);
    // Hint must remain so the next genuine restart still detects + clears it.
    expect(existsSync(restartRequiredPath(fakeHome))).toBe(true);
  });

  test("warning text contains the actionable /quit instruction", () => {
    expect(MISSED_RESTART_WARNING).toContain("WARNING");
    expect(MISSED_RESTART_WARNING).toContain("/quit");
    expect(MISSED_RESTART_WARNING).toContain("built-in Read/Edit/Grep");
  });

  test("corrupt hint JSON → cleared, no throw", () => {
    mkdirSync(join(fakeHome, ".ashlr"), { recursive: true });
    writeFileSync(restartRequiredPath(fakeHome), "{not valid json");
    let stderr = "";
    const result = checkMissedRestart({
      home: fakeHome,
      stderr: (m) => { stderr += m; },
    });
    expect(result.outcome).toBe("error");
    expect(result.cleared).toBe(true);
    expect(stderr).toBe("");
    expect(existsSync(restartRequiredPath(fakeHome))).toBe(false);
  });

  test("hint exactly at freshness boundary is treated as stale", () => {
    // writtenAt = now - RESTART_HINT_FRESHNESS_MS exactly → ageMs equals
    // boundary; the check uses `<` so this counts as stale.
    const boundary = new Date(
      Date.now() - RESTART_HINT_FRESHNESS_MS,
    ).toISOString();
    writeHint(fakeHome, { writtenAt: boundary, pid: process.pid });

    const result = checkMissedRestart({ home: fakeHome });
    expect(result.outcome).toBe("stale");
    expect(existsSync(restartRequiredPath(fakeHome))).toBe(false);
  });
});
