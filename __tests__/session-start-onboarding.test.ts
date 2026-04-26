/**
 * Tests for the Track F onboarding state machine and permission consent flow
 * in hooks/session-start.ts.
 *
 * Coverage:
 *   - Banner state machine: first run → /ashlr-start CTA
 *   - Second run (started:true, completed:false) → "finish setup" hint
 *   - Third+ run (completed:true) → silent (null)
 *   - ASHLR_PERMISSIONS_CONSENT=skip → no consent prompt
 *   - mcp__plugin_ashlr_* already in allow list → no consent prompt
 *   - permissionsConsent:"declined" in config → not re-prompted
 *   - shouldAutoGrantPermissions respects all guards
 *   - maybeAutoGrantPermissions writes permissionsConsent to config
 *   - buildOnboardingBanner covers all three states
 *   - getOnboardingBannerState covers all transitions
 *
 * Tests use mkdtempSync + HOME override so real ~/.claude/settings.json
 * and ~/.ashlr/config.json are never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  getOnboardingBannerState,
  buildOnboardingBanner,
  ashlrConfigPath,
  readAshlrConfig,
  writeAshlrConfig,
  isAshlrWildcardPresent,
  shouldAutoGrantPermissions,
  maybeAutoGrantPermissions,
} from "../hooks/session-start";

import {
  writeOnboardingState,
  writeStamp,
  stampPath,
  onboardingStatePath,
} from "../scripts/onboarding-wizard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fakeHome: string;

const origEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) origEnv[k] = process.env[k];
}

function restoreEnv(...keys: string[]): void {
  for (const k of keys) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
}

/** Write a fake ~/.claude/settings.json with an allow list. */
function writeSettings(home: string, allow: string[]): string {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify({ permissions: { allow } }, null, 2));
  return p;
}

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "ashlr-ob-test-"));
  saveEnv("ASHLR_PERMISSIONS_CONSENT", "ASHLR_HOME_OVERRIDE");
  // Use ASHLR_HOME_OVERRIDE so functions that default to homedir() can be
  // tested without modifying real files.
  process.env.ASHLR_HOME_OVERRIDE = fakeHome;
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
  restoreEnv("ASHLR_PERMISSIONS_CONSENT", "ASHLR_HOME_OVERRIDE");
});

// ---------------------------------------------------------------------------
// getOnboardingBannerState
// ---------------------------------------------------------------------------

describe("getOnboardingBannerState", () => {
  test("returns 'first' when no stamp and no onboarding.json", () => {
    expect(getOnboardingBannerState(fakeHome)).toBe("first");
  });

  test("returns 'first' when stamp exists but no onboarding.json", () => {
    writeStamp(fakeHome);
    expect(getOnboardingBannerState(fakeHome)).toBe("first");
  });

  test("returns 'in-progress' when started:true completed:false", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: false, lastStep: 2 }, fakeHome);
    expect(getOnboardingBannerState(fakeHome)).toBe("in-progress");
  });

  test("returns 'done' when completed:true", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: true, completedAt: new Date().toISOString() }, fakeHome);
    expect(getOnboardingBannerState(fakeHome)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// buildOnboardingBanner
// ---------------------------------------------------------------------------

describe("buildOnboardingBanner", () => {
  test("first run → contains /ashlr-start and '0 tokens'", () => {
    const banner = buildOnboardingBanner(fakeHome);
    expect(banner).not.toBeNull();
    expect(banner).toContain("/ashlr-start");
    expect(banner).toContain("0 tokens");
  });

  test("in-progress → contains 'finish setup' and step number", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: false, lastStep: 3 }, fakeHome);
    const banner = buildOnboardingBanner(fakeHome);
    expect(banner).not.toBeNull();
    expect(banner).toContain("finish setup");
    expect(banner).toContain("step 3");
  });

  test("in-progress with no lastStep → shows step 0", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: false }, fakeHome);
    const banner = buildOnboardingBanner(fakeHome);
    expect(banner).toContain("step 0");
  });

  test("done → null (silent)", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: true }, fakeHome);
    expect(buildOnboardingBanner(fakeHome)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isAshlrWildcardPresent
// ---------------------------------------------------------------------------

describe("isAshlrWildcardPresent", () => {
  test("false when settings.json missing", () => {
    expect(isAshlrWildcardPresent(fakeHome)).toBe(false);
  });

  test("false when allow list is empty", () => {
    writeSettings(fakeHome, []);
    expect(isAshlrWildcardPresent(fakeHome)).toBe(false);
  });

  test("false when allow list has unrelated entries", () => {
    writeSettings(fakeHome, ["Bash(git diff:*)", "mcp__webfetch__*"]);
    expect(isAshlrWildcardPresent(fakeHome)).toBe(false);
  });

  test("true for mcp__plugin_ashlr_* catch-all", () => {
    writeSettings(fakeHome, ["mcp__plugin_ashlr_*"]);
    expect(isAshlrWildcardPresent(fakeHome)).toBe(true);
  });

  test("true for mcp__ashlr-* legacy catch-all", () => {
    writeSettings(fakeHome, ["mcp__ashlr-*"]);
    expect(isAshlrWildcardPresent(fakeHome)).toBe(true);
  });

  test("true for per-server wildcard mcp__ashlr-efficiency__*", () => {
    writeSettings(fakeHome, ["mcp__ashlr-efficiency__*"]);
    expect(isAshlrWildcardPresent(fakeHome)).toBe(true);
  });

  test("true for router canonical mcp__plugin_ashlr_ashlr__ashlr__read", () => {
    writeSettings(fakeHome, ["mcp__plugin_ashlr_ashlr__ashlr__read"]);
    expect(isAshlrWildcardPresent(fakeHome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoGrantPermissions
// ---------------------------------------------------------------------------

describe("shouldAutoGrantPermissions", () => {
  test("returns true when no obstacles", () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    expect(shouldAutoGrantPermissions(fakeHome)).toBe(true);
  });

  test("returns false when ASHLR_PERMISSIONS_CONSENT=skip", () => {
    process.env.ASHLR_PERMISSIONS_CONSENT = "skip";
    expect(shouldAutoGrantPermissions(fakeHome)).toBe(false);
  });

  test("returns false when config has permissionsConsent:declined", () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    writeAshlrConfig({ permissionsConsent: "declined" }, fakeHome);
    expect(shouldAutoGrantPermissions(fakeHome)).toBe(false);
  });

  test("returns false when wildcard already in allow list", () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    writeSettings(fakeHome, ["mcp__plugin_ashlr_*"]);
    expect(shouldAutoGrantPermissions(fakeHome)).toBe(false);
  });

  test("returns false when legacy wildcard already in allow list", () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    writeSettings(fakeHome, ["mcp__ashlr-*"]);
    expect(shouldAutoGrantPermissions(fakeHome)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readAshlrConfig / writeAshlrConfig
// ---------------------------------------------------------------------------

describe("readAshlrConfig", () => {
  test("returns empty object when file missing", () => {
    expect(readAshlrConfig(fakeHome)).toEqual({});
  });

  test("returns parsed content", () => {
    writeAshlrConfig({ permissionsConsent: "granted", grantedAt: "2026-01-01" }, fakeHome);
    const cfg = readAshlrConfig(fakeHome);
    expect(cfg.permissionsConsent).toBe("granted");
    expect(cfg.grantedAt).toBe("2026-01-01");
  });

  test("merges without losing existing keys", () => {
    writeAshlrConfig({ foo: "bar" }, fakeHome);
    writeAshlrConfig({ baz: "qux" }, fakeHome);
    const cfg = readAshlrConfig(fakeHome);
    expect(cfg.foo).toBe("bar");
    expect(cfg.baz).toBe("qux");
  });
});

// ---------------------------------------------------------------------------
// maybeAutoGrantPermissions
// ---------------------------------------------------------------------------

describe("maybeAutoGrantPermissions", () => {
  test("skipped when ASHLR_PERMISSIONS_CONSENT=skip → returns null", async () => {
    process.env.ASHLR_PERMISSIONS_CONSENT = "skip";
    const result = await maybeAutoGrantPermissions(fakeHome);
    expect(result).toBeNull();
  });

  test("skipped when wildcard already present → returns null", async () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    writeSettings(fakeHome, ["mcp__plugin_ashlr_*"]);
    const result = await maybeAutoGrantPermissions(fakeHome);
    expect(result).toBeNull();
  });

  test("skipped when permissionsConsent:declined in config → returns null", async () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    writeAshlrConfig({ permissionsConsent: "declined" }, fakeHome);
    const result = await maybeAutoGrantPermissions(fakeHome);
    expect(result).toBeNull();
  });

  test("grants permissions and returns banner text on first run", async () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    // No settings.json → should grant
    const result = await maybeAutoGrantPermissions(fakeHome);
    // Banner should mention auto-allow
    expect(result).not.toBeNull();
    expect(result).toContain("ashlr");
    expect(result).toContain("auto-allow");

    // Config should record the grant
    const cfg = readAshlrConfig(fakeHome);
    expect(cfg.permissionsConsent).toBe("granted");
    expect(typeof cfg.grantedAt).toBe("string");

    // settings.json should now have an ashlr entry
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const allow: string[] = settings.permissions?.allow ?? [];
    expect(allow.some((e: string) => e.includes("ashlr"))).toBe(true);
  });

  test("second call (wildcard now present) → returns null (idempotent)", async () => {
    delete process.env.ASHLR_PERMISSIONS_CONSENT;
    await maybeAutoGrantPermissions(fakeHome);
    // Second call — wildcard is now present
    const second = await maybeAutoGrantPermissions(fakeHome);
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: onboarding state written by wizard, read by banner
// ---------------------------------------------------------------------------

describe("onboarding state round-trip", () => {
  test("wizard marks started → banner shows in-progress", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: false, lastStep: 2 }, fakeHome);
    expect(getOnboardingBannerState(fakeHome)).toBe("in-progress");
    const banner = buildOnboardingBanner(fakeHome);
    expect(banner).toContain("finish setup");
  });

  test("wizard marks completed → banner is silent", () => {
    writeStamp(fakeHome);
    writeOnboardingState({ started: true, completed: true }, fakeHome);
    expect(getOnboardingBannerState(fakeHome)).toBe("done");
    expect(buildOnboardingBanner(fakeHome)).toBeNull();
  });

  test("onboarding.json path is ~/.ashlr/onboarding.json", () => {
    expect(onboardingStatePath(fakeHome)).toBe(join(fakeHome, ".ashlr", "onboarding.json"));
  });
});
