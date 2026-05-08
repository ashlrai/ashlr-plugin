/**
 * Tests for writeProjectHint / projectHintPath — the v1.19.1 hotfix that
 * bridges hook-context env (CLAUDE_PROJECT_DIR) into a file the MCP
 * subprocesses can read, since Claude Code does not forward env vars to
 * MCP spawns.
 *
 * The paired consumer-side logic lives in `servers/_cwd-clamp.ts` and is
 * exercised in `__tests__/cwd-clamp.test.ts`; this file covers the writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  projectHintPath,
  writeProjectHint,
} from "../hooks/session-start";

let fakeHome: string;
let fakeProject: string;

const originalCPD = process.env.CLAUDE_PROJECT_DIR;
const originalSID = process.env.CLAUDE_SESSION_ID;
const originalASID = process.env.ASHLR_SESSION_ID;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "ashlr-hint-home-"));
  fakeProject = await mkdtemp(join(tmpdir(), "ashlr-hint-proj-"));
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
  await rm(fakeProject, { recursive: true, force: true });
  // Restore env
  if (originalCPD === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalCPD;
  if (originalSID === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = originalSID;
  if (originalASID === undefined) delete process.env.ASHLR_SESSION_ID;
  else process.env.ASHLR_SESSION_ID = originalASID;
});

describe("projectHintPath", () => {
  test("returns ~/.ashlr/last-project.json under given home", () => {
    expect(projectHintPath(fakeHome)).toBe(
      join(fakeHome, ".ashlr", "last-project.json"),
    );
  });
});

describe("writeProjectHint", () => {
  test("writes a well-formed JSON file with projectDir + updatedAt", () => {
    const now = new Date("2026-04-23T12:34:56Z");
    const res = writeProjectHint({
      home: fakeHome,
      projectDir: fakeProject,
      sessionId: "sess-xyz",
      now,
    });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(join(fakeHome, ".ashlr", "last-project.json"));
    const content = JSON.parse(readFileSync(res.path!, "utf-8")) as {
      projectDir?: string;
      updatedAt?: string;
      sessionId?: string;
    };
    expect(content.projectDir).toBe(fakeProject);
    expect(content.updatedAt).toBe("2026-04-23T12:34:56.000Z");
    expect(content.sessionId).toBe("sess-xyz");
  });

  test("picks up CLAUDE_PROJECT_DIR from env when projectDir opt is absent", () => {
    process.env.CLAUDE_PROJECT_DIR = fakeProject;
    const res = writeProjectHint({ home: fakeHome });
    expect(res.ok).toBe(true);
    const content = JSON.parse(readFileSync(res.path!, "utf-8")) as {
      projectDir?: string;
    };
    expect(content.projectDir).toBe(fakeProject);
  });

  test("picks up CLAUDE_SESSION_ID from env when sessionId opt is absent", () => {
    process.env.CLAUDE_SESSION_ID = "env-sess-123";
    const res = writeProjectHint({ home: fakeHome, projectDir: fakeProject });
    expect(res.ok).toBe(true);
    const content = JSON.parse(readFileSync(res.path!, "utf-8")) as {
      sessionId?: string;
    };
    expect(content.sessionId).toBe("env-sess-123");
  });

  test("falls back to ASHLR_SESSION_ID when CLAUDE_SESSION_ID is absent", () => {
    delete process.env.CLAUDE_SESSION_ID;
    process.env.ASHLR_SESSION_ID = "ashlr-sess-abc";
    const res = writeProjectHint({ home: fakeHome, projectDir: fakeProject });
    expect(res.ok).toBe(true);
    const content = JSON.parse(readFileSync(res.path!, "utf-8")) as {
      sessionId?: string;
    };
    expect(content.sessionId).toBe("ashlr-sess-abc");
  });

  test("v1.19.2: ALWAYS writes a sessionId - derives one when env is absent", () => {
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.ASHLR_SESSION_ID;
    const res = writeProjectHint({ home: fakeHome, projectDir: fakeProject });
    expect(res.ok).toBe(true);
    const content = JSON.parse(readFileSync(res.path!, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(typeof content.sessionId).toBe("string");
    expect((content.sessionId as string).length).toBeGreaterThan(0);
    // Derived id is prefixed 'h' (hash-of-ppid-time-random) per v1.19.2.
    expect((content.sessionId as string).startsWith("h")).toBe(true);
  });

  test("no-ops when no project dir is available AND cwd looks like plugin install", async () => {
    // The cwd-fallback path (added so MCP subprocesses can find the project
    // when Claude Code didn't forward CLAUDE_PROJECT_DIR) is suppressed when
    // the cwd looks like a plugin-cache directory — guards against writing
    // the install dir into the hint.
    delete process.env.CLAUDE_PROJECT_DIR;
    // Build a path containing ".claude/plugins/cache/" — that's the substring
    // cwdLooksLikePluginRoot matches on. mkdtemp can't recursively create
    // parent dirs, so build with mkdirSync then mkdtemp inside it.
    const cacheParent = join(tmpdir(), `ashlr-cache-test-${process.pid}`, ".claude", "plugins", "cache");
    mkdirSync(cacheParent, { recursive: true });
    const fakePluginCache = await mkdtemp(join(cacheParent, "plugin-"));
    const original = process.cwd();
    try {
      process.chdir(fakePluginCache);
      const res = writeProjectHint({ home: fakeHome });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("no-project-dir");
      expect(existsSync(join(fakeHome, ".ashlr", "last-project.json"))).toBe(false);
    } finally {
      process.chdir(original);
      await rm(join(tmpdir(), `ashlr-cache-test-${process.pid}`), { recursive: true, force: true });
    }
  });

  test("falls back to process.cwd() when env is empty and cwd is a real project", () => {
    // Repro the bug seen in v1.28: Claude Code spawns hooks with cwd=user
    // project but doesn't always set CLAUDE_PROJECT_DIR. Without this
    // fallback the hint stayed stale and the MCP cwd-clamp refused every
    // tool call against the user's project.
    delete process.env.CLAUDE_PROJECT_DIR;
    const original = process.cwd();
    try {
      process.chdir(fakeProject);
      const res = writeProjectHint({ home: fakeHome });
      expect(res.ok).toBe(true);
      const written = JSON.parse(
        readFileSync(join(fakeHome, ".ashlr", "last-project.json"), "utf-8"),
      ) as { projectDir: string };
      // canonicalize: macOS resolves /var → /private/var symlink
      expect(written.projectDir).toBe(process.cwd());
    } finally {
      process.chdir(original);
    }
  });

  test("no-ops when projectDir points at a nonexistent path", () => {
    const res = writeProjectHint({
      home: fakeHome,
      projectDir: join(tmpdir(), "ashlr-definitely-does-not-exist-abc"),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("stat-failed");
    expect(existsSync(join(fakeHome, ".ashlr", "last-project.json"))).toBe(false);
  });

  test("no-ops when projectDir points at a file (not directory)", () => {
    const file = join(fakeProject, "regular.txt");
    writeFileSync(file, "x");
    const res = writeProjectHint({ home: fakeHome, projectDir: file });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-a-directory");
    expect(existsSync(join(fakeHome, ".ashlr", "last-project.json"))).toBe(false);
  });

  test("overwrites existing hint (idempotent across sessions)", () => {
    const r1 = writeProjectHint({
      home: fakeHome,
      projectDir: fakeProject,
      sessionId: "sess-1",
      now: new Date("2026-04-22T00:00:00Z"),
    });
    expect(r1.ok).toBe(true);
    const r2 = writeProjectHint({
      home: fakeHome,
      projectDir: fakeProject,
      sessionId: "sess-2",
      now: new Date("2026-04-23T00:00:00Z"),
    });
    expect(r2.ok).toBe(true);
    const content = JSON.parse(readFileSync(r2.path!, "utf-8")) as {
      sessionId?: string;
      updatedAt?: string;
    };
    expect(content.sessionId).toBe("sess-2");
    expect(content.updatedAt).toBe("2026-04-23T00:00:00.000Z");
  });

  test("creates ~/.ashlr directory if missing", async () => {
    // fakeHome starts empty — no .ashlr/ subdir.
    expect(existsSync(join(fakeHome, ".ashlr"))).toBe(false);
    const res = writeProjectHint({ home: fakeHome, projectDir: fakeProject });
    expect(res.ok).toBe(true);
    expect(existsSync(join(fakeHome, ".ashlr"))).toBe(true);
    expect(existsSync(join(fakeHome, ".ashlr", "last-project.json"))).toBe(true);
  });

  test("pretty-printed JSON output (human-readable for debugging)", () => {
    const res = writeProjectHint({ home: fakeHome, projectDir: fakeProject });
    expect(res.ok).toBe(true);
    const raw = readFileSync(res.path!, "utf-8");
    // JSON.stringify(x, null, 2) produces newlines + indentation; sanity check.
    expect(raw).toContain("\n");
    expect(raw).toContain("  \"projectDir\"");
  });
});
