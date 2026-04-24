/**
 * v1.19.2 — session-id hint fallback tests.
 *
 * Validates that currentSessionId() and candidateSessionIds() in
 * servers/_stats.ts read ~/.ashlr/last-project.json to resolve a stable
 * session id across writer/reader subprocesses that don't see
 * CLAUDE_SESSION_ID in their env.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let fakeHome: string;
let originalHome: string | undefined;
let originalSessionEnv: string | undefined;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "ashlr-stats-hint-"));
  originalHome = process.env.HOME;
  originalSessionEnv = process.env.CLAUDE_SESSION_ID;
  process.env.HOME = fakeHome;
  delete process.env.CLAUDE_SESSION_ID;
  await mkdir(join(fakeHome, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalSessionEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = originalSessionEnv;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("currentSessionId with session hint", () => {
  test("uses hint file sessionId when env is absent and hint is fresh", async () => {
    await writeFile(
      join(fakeHome, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp",
        sessionId: "test-session-123",
        updatedAt: new Date().toISOString(),
      }),
    );
    const mod = await import("../servers/_stats?t=" + Date.now());
    const id = mod.currentSessionId();
    expect(id).toBe("test-session-123");
  });

  test("falls back to ppid-hash when hint file is absent", async () => {
    const mod = await import("../servers/_stats?t=" + Date.now());
    const id = mod.currentSessionId();
    expect(id).toMatch(/^p[0-9a-f]+$/);
  });

  test("ignores hint with stale updatedAt (>24h)", async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(
      join(fakeHome, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp",
        sessionId: "stale-session",
        updatedAt: staleDate,
      }),
    );
    const mod = await import("../servers/_stats?t=" + Date.now());
    const id = mod.currentSessionId();
    expect(id).not.toBe("stale-session");
    expect(id).toMatch(/^p[0-9a-f]+$/);
  });

  test("env var wins over hint", async () => {
    await writeFile(
      join(fakeHome, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp",
        sessionId: "hint-session",
        updatedAt: new Date().toISOString(),
      }),
    );
    process.env.CLAUDE_SESSION_ID = "env-session";
    const mod = await import("../servers/_stats?t=" + Date.now());
    const id = mod.currentSessionId();
    expect(id).toBe("env-session");
  });
});

describe("candidateSessionIds with session hint", () => {
  test("includes hint + ppid-hash when hint is fresh", async () => {
    await writeFile(
      join(fakeHome, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp",
        sessionId: "hint-id-xyz",
        updatedAt: new Date().toISOString(),
      }),
    );
    const mod = await import("../servers/_stats?t=" + Date.now());
    const ids = mod.candidateSessionIds();
    expect(ids).toContain("hint-id-xyz");
    expect(ids.some((id: string) => /^p[0-9a-f]+$/.test(id))).toBe(true);
  });

  test("includes env + hint + ppid when all three present", async () => {
    await writeFile(
      join(fakeHome, ".ashlr", "last-project.json"),
      JSON.stringify({
        projectDir: "/tmp",
        sessionId: "hint-id",
        updatedAt: new Date().toISOString(),
      }),
    );
    process.env.CLAUDE_SESSION_ID = "env-id";
    const mod = await import("../servers/_stats?t=" + Date.now());
    const ids = mod.candidateSessionIds();
    expect(ids).toContain("env-id");
    expect(ids).toContain("hint-id");
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  test("falls back to just ppid when no env + no hint", async () => {
    const mod = await import("../servers/_stats?t=" + Date.now());
    const ids = mod.candidateSessionIds();
    expect(ids.length).toBe(1);
    expect(ids[0]).toMatch(/^p[0-9a-f]+$/);
  });
});
