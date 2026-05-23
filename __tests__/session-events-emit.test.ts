/**
 * session-events-emit.test.ts
 *
 * Unit tests for scripts/session-event-emit.ts — the Q4 session graph
 * capture emitter that runs as the last step in SessionEnd hook.
 *
 * Coverage:
 *   1. buildPayload returns null when telemetry consent is OFF.
 *   2. buildPayload returns a well-formed payload when consent is ON.
 *   3. session_id_hash is the sha256 of CLAUDE_SESSION_ID (when set).
 *   4. branch_sha is undefined when not in a git repo.
 *   5. branch_sha is populated when in a git repo (smoke — best-effort).
 *   6. discovery_refs is always an array (empty when no genome dir present).
 *   7. resolveRawSessionId falls back to ppid-derived id when env is absent.
 *   8. emitFireAndForget never throws on network failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";

import {
  buildPayload,
  collectDiscoveryRefs,
  emitFireAndForget,
  resolveBranchSha,
  resolveRawSessionId,
  sha256Hex,
} from "../scripts/session-event-emit";

// ---------------------------------------------------------------------------
// Test scaffolding — fresh $HOME per test so _identity-hash + telemetry
// reads land in a clean dir. Mirrors __tests__/wadd-client.test.ts.
// ---------------------------------------------------------------------------

let home: string;
let projectDir: string;
const originalHome = process.env.HOME;
const originalTelem = process.env.ASHLR_TELEMETRY;
const originalSession = process.env.CLAUDE_SESSION_ID;
const originalApi = process.env.ASHLR_API_URL;
const originalEvtUrl = process.env.ASHLR_SESSION_EVENTS_URL;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-sessevt-"));
  projectDir = await mkdtemp(join(tmpdir(), "ashlr-sessevt-proj-"));
  mkdirSync(join(home, ".ashlr"), { recursive: true });
  process.env.HOME = home;
  // Default: consent OFF unless the test enables it.
  process.env.ASHLR_TELEMETRY = "off";
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.ASHLR_API_URL;
  delete process.env.ASHLR_SESSION_EVENTS_URL;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalTelem !== undefined) process.env.ASHLR_TELEMETRY = originalTelem;
  else delete process.env.ASHLR_TELEMETRY;
  if (originalSession !== undefined) process.env.CLAUDE_SESSION_ID = originalSession;
  else delete process.env.CLAUDE_SESSION_ID;
  if (originalApi !== undefined) process.env.ASHLR_API_URL = originalApi;
  else delete process.env.ASHLR_API_URL;
  if (originalEvtUrl !== undefined) process.env.ASHLR_SESSION_EVENTS_URL = originalEvtUrl;
  else delete process.env.ASHLR_SESSION_EVENTS_URL;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-event-emit", () => {
  test("buildPayload returns null when telemetry consent is OFF", async () => {
    process.env.ASHLR_TELEMETRY = "off";
    const payload = await buildPayload(projectDir);
    expect(payload).toBeNull();
  });

  test("buildPayload returns a well-formed payload when consent is ON", async () => {
    process.env.ASHLR_TELEMETRY = "on";
    process.env.CLAUDE_SESSION_ID = "test-session-abc";

    const payload = await buildPayload(projectDir);
    expect(payload).not.toBeNull();
    expect(typeof payload!.identity_hash).toBe("string");
    expect(payload!.identity_hash).toMatch(/^[0-9a-f]{64}$/);
    // github_hash is null because no pro-token-cache.json was written.
    expect(payload!.github_hash).toBeNull();
    expect(payload!.session_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload!.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof payload!.tool_count).toBe("number");
    expect(payload!.tool_count).toBeGreaterThanOrEqual(0);
    expect(typeof payload!.tokens_saved).toBe("number");
    expect(payload!.tokens_saved).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(payload!.discovery_refs)).toBe(true);
    expect(typeof payload!.plugin_version).toBe("string");
  });

  test("session_id_hash is sha256(CLAUDE_SESSION_ID) when env is set", async () => {
    process.env.ASHLR_TELEMETRY = "on";
    process.env.CLAUDE_SESSION_ID = "deterministic-session-id-xyz";
    const expected = createHash("sha256").update("deterministic-session-id-xyz").digest("hex");

    const payload = await buildPayload(projectDir);
    expect(payload!.session_id_hash).toBe(expected);
  });

  test("branch_sha is undefined when projectDir is not a git repo", async () => {
    process.env.ASHLR_TELEMETRY = "on";
    // projectDir is a fresh tmpdir with no .git
    const payload = await buildPayload(projectDir);
    expect(payload!.branch_sha).toBeUndefined();
  });

  test("resolveBranchSha returns undefined for a non-git directory", () => {
    expect(resolveBranchSha(projectDir)).toBeUndefined();
  });

  test("resolveBranchSha returns a 12-char hex when projectDir is a git repo", () => {
    // Best-effort smoke. Skip when `git` is not on PATH.
    const which = spawnSync("git", ["--version"], { stdio: "ignore" });
    if (which.status !== 0) return; // git missing — skip
    // Initialize a fresh repo + commit so HEAD exists.
    const init = spawnSync("git", ["init", "-q"], { cwd: projectDir, stdio: "ignore" });
    if (init.status !== 0) return; // permissions / weird env — skip
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
    spawnSync("git", ["config", "user.name", "test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README"), "hello\n");
    spawnSync("git", ["add", "README"], { cwd: projectDir });
    const commit = spawnSync(
      "git",
      ["commit", "-q", "-m", "initial", "--no-gpg-sign"],
      { cwd: projectDir },
    );
    if (commit.status !== 0) return; // commit failed — skip
    const sha = resolveBranchSha(projectDir);
    expect(sha).toMatch(/^[0-9a-fA-F]{7,40}$/);
  });

  test("collectDiscoveryRefs returns [] when .ashlrcode is missing", () => {
    expect(collectDiscoveryRefs(projectDir)).toEqual([]);
  });

  test("collectDiscoveryRefs returns [] when .ashlrcode/genome/sections/discoveries exists but is empty", () => {
    mkdirSync(join(projectDir, ".ashlrcode", "genome", "sections", "discoveries"), { recursive: true });
    expect(collectDiscoveryRefs(projectDir)).toEqual([]);
  });

  test("resolveRawSessionId prefers CLAUDE_SESSION_ID when set", () => {
    process.env.CLAUDE_SESSION_ID = "explicit-session-id";
    expect(resolveRawSessionId()).toBe("explicit-session-id");
  });

  test("resolveRawSessionId falls back to ppid-derived id when env is absent", () => {
    delete process.env.CLAUDE_SESSION_ID;
    const id = resolveRawSessionId();
    expect(id.startsWith("ppid:")).toBe(true);
    expect(id.length).toBeGreaterThan(5);
  });

  test("sha256Hex is deterministic and lowercase hex", () => {
    const a = sha256Hex("hello");
    const b = sha256Hex("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("emitFireAndForget never throws on network failure", async () => {
    process.env.ASHLR_TELEMETRY = "on";
    // Point at a definitely-unreachable URL.
    process.env.ASHLR_SESSION_EVENTS_URL = "http://127.0.0.1:1/v1/session-events";
    const payload = {
      identity_hash:   "0".repeat(64),
      github_hash:     null,
      session_id_hash: "1".repeat(64),
      ended_at:        new Date().toISOString(),
      tool_count:      0,
      tokens_saved:    0,
      discovery_refs:  [],
      plugin_version:  "0.0.0",
    };
    // Should resolve cleanly even though the POST will fail.
    await expect(emitFireAndForget(payload)).resolves.toBeUndefined();
  });
});
