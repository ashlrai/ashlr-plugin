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
import { existsSync, readFileSync, writeFileSync } from "fs";
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

  test("omits sessionId field when no session id available anywhere", () => {
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.ASHLR_SESSION_ID;
    const res = writeProjectHint({ home: fakeHome, projectDir: fakeProject });
    expect(res.ok).toBe(true);
    const content = JSON.parse(readFileSync(res.path!, "utf-8")) as Record<
      string,
      unknown
    >;
    expect("sessionId" in content).toBe(false);
  });

  test("no-ops when no project dir is available (returns ok:false, no write)", () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const res = writeProjectHint({ home: fakeHome });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-project-dir");
    expect(existsSync(join(fakeHome, ".ashlr", "last-project.json"))).toBe(false);
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
