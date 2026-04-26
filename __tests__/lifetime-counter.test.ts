/**
 * lifetime-counter.test.ts — invariants for the session-id resolution chain
 * that feeds the lifetime savings counter.
 *
 * Per the v1.18 / v1.20.2 lessons (session +0 status-line drift fixed three
 * times before consolidation), the session counter relies on
 * `candidateSessionIds()` which surfaces up to 3 sources:
 *   1. CLAUDE_SESSION_ID (Claude Code env var; status-line sees it)
 *   2. ~/.ashlr/last-project.json hint file (writer-side hint)
 *   3. ppid-derived hash (last-resort fallback)
 *
 * This file locks down two properties:
 *   A. Deduplication — if two sources resolve to the same id, the array
 *      contains it ONCE (not twice). Otherwise the reader's sum-across-
 *      candidates loop would double-count one bucket.
 *   B. Stability — the same combination of inputs returns a stable order
 *      and content across calls (no nondeterministic ordering).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { candidateSessionIds, readSessionHint, SESSION_HINT_TTL_MS } from "../servers/_stats";

let originalHome: string | undefined;
let originalSessionId: string | undefined;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalSessionId = process.env.CLAUDE_SESSION_ID;
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-lifetime-test-"));
  process.env.HOME = tmpHome;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = originalSessionId;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeHint(sessionId: string, ageMs: number = 0): void {
  mkdirSync(join(tmpHome, ".ashlr"), { recursive: true });
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(tmpHome, ".ashlr", "last-project.json"),
    JSON.stringify({ sessionId, updatedAt }),
    "utf-8",
  );
}

describe("candidateSessionIds — dedup & stability", () => {
  it("returns CLAUDE_SESSION_ID + hint + ppid as 3 distinct ids when all differ", () => {
    process.env.CLAUDE_SESSION_ID = "env-id-aaa";
    writeHint("hint-id-bbb");
    const ids = candidateSessionIds();
    expect(ids[0]).toBe("env-id-aaa");
    expect(ids[1]).toBe("hint-id-bbb");
    // ids[2] is ppid-derived; it must not collide with either of the above.
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("dedupes when env id == hint id (single bucket, not double-counted)", () => {
    // This is the regression guard: if Claude Code now propagates the env
    // var to MCP and the session-start hook ALSO captures it, both sources
    // converge on the same id. The reader must NOT iterate the same bucket
    // twice — that was the inflation risk noted in the v1.22 audit.
    process.env.CLAUDE_SESSION_ID = "shared-id-xyz";
    writeHint("shared-id-xyz");
    const ids = candidateSessionIds();
    const occurrences = ids.filter((id) => id === "shared-id-xyz").length;
    expect(occurrences).toBe(1);
  });

  it("dedupes when env id == ppid id (same physical process)", () => {
    // ppidSessionId is a hash of PPID — we can't easily force collision, but
    // we CAN assert that whatever ppid value is generated, it's deduped if
    // CLAUDE_SESSION_ID happens to match.
    const idsBefore = candidateSessionIds();
    const ppidId = idsBefore[idsBefore.length - 1]!; // last entry is ppid
    process.env.CLAUDE_SESSION_ID = ppidId;
    const idsAfter = candidateSessionIds();
    const occurrences = idsAfter.filter((id) => id === ppidId).length;
    expect(occurrences).toBe(1);
  });

  it("stale hint (older than TTL) is ignored, not surfaced as a fourth bucket", () => {
    process.env.CLAUDE_SESSION_ID = "current-id";
    writeHint("stale-id", SESSION_HINT_TTL_MS + 60_000); // 1 min over TTL
    const ids = candidateSessionIds();
    expect(ids).not.toContain("stale-id");
    expect(readSessionHint()).toBeNull();
  });

  it("returns the same id list across two consecutive calls (no nondeterminism)", () => {
    process.env.CLAUDE_SESSION_ID = "stable-id";
    writeHint("hint-id");
    const a = candidateSessionIds();
    const b = candidateSessionIds();
    expect(a).toEqual(b);
  });

  it("never returns an empty array — ppid fallback always present", () => {
    delete process.env.CLAUDE_SESSION_ID;
    // No hint written.
    const ids = candidateSessionIds();
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids[0]).toBeTruthy();
  });
});
