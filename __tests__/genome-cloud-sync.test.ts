/**
 * genome-cloud-sync.test.ts — Q2 plugin-side cloud delta sync.
 *
 * Covers:
 *   - Free tier → early skip, no fetch
 *   - Pro tier → calls GET, writes deltas, advances cursor
 *   - Cursor advances; second call with no new deltas is a no-op
 *   - Network failure → graceful (no thrown error, no cursor update)
 *   - Pruning keeps at most CLOUD_RETENTION_LIMIT cloud sections
 *
 * All tests use a mock fetch — no real network.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  syncCloudDeltas,
  readCursor,
  cloudDir,
  commitsDir,
  prsDir,
  issuesDir,
  cursorPath,
  pruneCloudSections,
  CLOUD_RETENTION_LIMIT,
  type CloudDeltasResponse,
} from "../scripts/genome-cloud-sync";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-cloud-sync-"));
  // Minimal genome scaffold so the script doesn't bail with "no-local-genome".
  mkdirSync(join(dir, ".ashlrcode", "genome"), { recursive: true });
  return dir;
}

function makeFetch(responses: Array<{ status?: number; body?: unknown; throws?: boolean }>) {
  let callCount = 0;
  const calls: string[] = [];
  const fn = async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const r = responses[callCount++] ?? responses[responses.length - 1];
    if (!r) throw new Error("no mock response");
    if (r.throws) throw new Error("mock network error");
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fn, calls: () => calls, count: () => callCount };
}

function commitDelta(cursor: number, sha: string) {
  return {
    id: cursor,
    cursor,
    kind: "commit" as const,
    sourceSha: sha,
    recordedAt: "2026-05-22T12:00:00Z",
    payload: { kind: "commit", sha, message: `c-${cursor}`, filesChanged: ["src/a.ts"] },
  };
}

function prDelta(cursor: number, num: number) {
  return {
    id: cursor,
    cursor,
    kind: "pr_merged" as const,
    sourceSha: String(num),
    recordedAt: "2026-05-22T12:00:00Z",
    payload: { kind: "pr_merged", number: num, title: `PR #${num}`, filesChanged: [] },
  };
}

function issueDelta(cursor: number, num: number) {
  return {
    id: cursor,
    cursor,
    kind: "issue_closed" as const,
    sourceSha: String(num),
    recordedAt: "2026-05-22T12:00:00Z",
    payload: { kind: "issue_closed", number: num, title: `Issue #${num}` },
  };
}

// ---------------------------------------------------------------------------
// Tier gate
// ---------------------------------------------------------------------------

describe("syncCloudDeltas — tier gate", () => {
  let repo: string;
  beforeEach(() => { repo = makeTmpRepo(); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("free tier skips immediately, no fetch", async () => {
    const f = makeFetch([]);
    const res = await syncCloudDeltas({
      tier: "free",
      cwd: repo,
      home: repo,
      fetchFn: f.fn,
      genomeId: "g1",
      proToken: "tok",
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("free-tier");
    expect(f.count()).toBe(0);
  });

  it("skips when ASHLR_CLOUD_GENOME_DISABLE=1", async () => {
    const old = process.env["ASHLR_CLOUD_GENOME_DISABLE"];
    process.env["ASHLR_CLOUD_GENOME_DISABLE"] = "1";
    try {
      const f = makeFetch([]);
      const res = await syncCloudDeltas({
        tier: "pro",
        cwd: repo,
        home: repo,
        fetchFn: f.fn,
        genomeId: "g1",
        proToken: "tok",
      });
      expect(res.skipped).toBe(true);
      expect(res.reason).toBe("kill-switch");
      expect(f.count()).toBe(0);
    } finally {
      if (old === undefined) delete process.env["ASHLR_CLOUD_GENOME_DISABLE"];
      else process.env["ASHLR_CLOUD_GENOME_DISABLE"] = old;
    }
  });

  it("skips when no .ashlrcode/genome exists", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ashlr-empty-"));
    try {
      const f = makeFetch([]);
      const res = await syncCloudDeltas({
        tier: "pro",
        cwd: empty,
        home: empty,
        fetchFn: f.fn,
        genomeId: "g1",
        proToken: "tok",
      });
      expect(res.skipped).toBe(true);
      expect(res.reason).toBe("no-local-genome");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("skips when no pro-token", async () => {
    const f = makeFetch([]);
    const res = await syncCloudDeltas({
      tier: "pro",
      cwd: repo,
      home: repo,
      fetchFn: f.fn,
      genomeId: "g1",
      // no proToken → falls back to file read; file doesn't exist → empty
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no-pro-token");
    expect(f.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("syncCloudDeltas — pro tier writes deltas", () => {
  let repo: string;
  beforeEach(() => { repo = makeTmpRepo(); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("writes commit + pr + issue sections and advances cursor", async () => {
    const body: CloudDeltasResponse = {
      deltas: [
        commitDelta(1, "a".repeat(40)),
        prDelta(2, 42),
        issueDelta(3, 7),
      ],
      nextCursor: 3,
    };
    const f = makeFetch([{ body }]);
    const res = await syncCloudDeltas({
      tier: "pro",
      cwd: repo,
      home: repo,
      fetchFn: f.fn,
      genomeId: "g1",
      proToken: "test-tok",
      apiUrl: "https://api.test",
    });

    expect(res.skipped).toBeUndefined();
    expect(res.written).toBe(3);
    expect(res.cursorBefore).toBe(0);
    expect(res.cursorAfter).toBe(3);

    // Files on disk
    expect(existsSync(join(commitsDir(repo), `${"a".repeat(40)}.json`))).toBe(true);
    // Q3: PR + issue deltas now write to dedicated subdirs (sections/prs/<id>.json
    // + sections/issues/<id>.json) instead of the envelope-wrapped cloud/ dir,
    // so retrieval can scan them directly. cloudDir() is left as legacy fallback.
    expect(existsSync(join(prsDir(repo), `42.json`))).toBe(true);
    expect(existsSync(join(issuesDir(repo), `7.json`))).toBe(true);

    // Cursor persisted
    const cur = readCursor(repo);
    expect(cur).toBeTruthy();
    expect(cur!.genomeId).toBe("g1");
    expect(cur!.cursor).toBe(3);

    // Fetch URL includes auth-style params
    const url = f.calls()[0]!;
    expect(url).toContain("/genome/cloud-deltas");
    expect(url).toContain("genome_id=g1");
    expect(url).toContain("since_cursor=0");
  });

  it("second call with no new deltas is a no-op and doesn't rewind cursor", async () => {
    // Seed cursor at 5
    mkdirSync(join(repo, ".ashlrcode", "genome"), { recursive: true });
    writeFileSync(
      cursorPath(repo),
      JSON.stringify({ genomeId: "g1", cursor: 5, lastSyncedAt: "x" }),
    );

    const body: CloudDeltasResponse = { deltas: [], nextCursor: 5 };
    const f = makeFetch([{ body }]);
    const res = await syncCloudDeltas({
      tier: "pro",
      cwd: repo,
      home: repo,
      fetchFn: f.fn,
      genomeId: "g1",
      proToken: "tok",
    });
    expect(res.written).toBe(0);
    expect(res.cursorBefore).toBe(5);
    expect(res.cursorAfter).toBe(5);

    // Verify the request used since_cursor=5
    expect(f.calls()[0]).toContain("since_cursor=5");

    // Cursor file unchanged value-wise.
    const cur = readCursor(repo);
    expect(cur!.cursor).toBe(5);
  });

  it("advances cursor across multiple delta batches", async () => {
    // First sync: 2 deltas (cursors 1, 2).
    const body1: CloudDeltasResponse = {
      deltas: [commitDelta(1, "x".repeat(40)), commitDelta(2, "y".repeat(40))],
      nextCursor: 2,
    };
    const f1 = makeFetch([{ body: body1 }]);
    const r1 = await syncCloudDeltas({
      tier: "pro", cwd: repo, home: repo,
      fetchFn: f1.fn, genomeId: "g1", proToken: "tok",
    });
    expect(r1.cursorAfter).toBe(2);

    // Second sync: cursor file says 2 → request uses since_cursor=2.
    const body2: CloudDeltasResponse = {
      deltas: [commitDelta(3, "z".repeat(40))],
      nextCursor: 3,
    };
    const f2 = makeFetch([{ body: body2 }]);
    const r2 = await syncCloudDeltas({
      tier: "pro", cwd: repo, home: repo,
      fetchFn: f2.fn, genomeId: "g1", proToken: "tok",
    });
    expect(r2.cursorBefore).toBe(2);
    expect(r2.cursorAfter).toBe(3);
    expect(f2.calls()[0]).toContain("since_cursor=2");
  });

  it("dry-run does not write sections or advance cursor", async () => {
    const body: CloudDeltasResponse = {
      deltas: [commitDelta(1, "q".repeat(40))],
      nextCursor: 1,
    };
    const f = makeFetch([{ body }]);
    const res = await syncCloudDeltas({
      tier: "pro", cwd: repo, home: repo,
      fetchFn: f.fn, genomeId: "g1", proToken: "tok",
      dryRun: true,
    });
    expect(res.written).toBe(1);
    expect(existsSync(join(commitsDir(repo), `${"q".repeat(40)}.json`))).toBe(false);
    expect(readCursor(repo)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("syncCloudDeltas — failure modes", () => {
  let repo: string;
  beforeEach(() => { repo = makeTmpRepo(); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("network error → graceful skip, no cursor update", async () => {
    // Seed cursor at 9 so we can verify it isn't touched.
    writeFileSync(
      cursorPath(repo),
      JSON.stringify({ genomeId: "g1", cursor: 9, lastSyncedAt: "old" }),
    );
    const f = makeFetch([{ throws: true }]);
    const res = await syncCloudDeltas({
      tier: "pro", cwd: repo, home: repo,
      fetchFn: f.fn, genomeId: "g1", proToken: "tok",
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("network-error");
    expect(res.cursorBefore).toBe(9);
    // Cursor file unchanged
    const cur = readCursor(repo);
    expect(cur!.cursor).toBe(9);
  });

  it("HTTP 403 → graceful skip, no cursor update", async () => {
    const f = makeFetch([{ status: 403, body: { error: "tier" } }]);
    const res = await syncCloudDeltas({
      tier: "pro", cwd: repo, home: repo,
      fetchFn: f.fn, genomeId: "g1", proToken: "tok",
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("http-403");
    expect(readCursor(repo)).toBeNull();
  });

  it("bad JSON → graceful skip", async () => {
    // Custom fetch that returns invalid JSON.
    // Use structural fetch type (url, init?) — not `typeof fetch`, which
    // requires `preconnect` and isn't relevant to sync's call site.
    const f: (url: string, init?: RequestInit) => Promise<Response> = async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
    const res = await syncCloudDeltas({
      tier: "pro", cwd: repo, home: repo,
      fetchFn: f, genomeId: "g1", proToken: "tok",
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("bad-json");
  });
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruneCloudSections", () => {
  let repo: string;
  beforeEach(() => { repo = makeTmpRepo(); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("keeps at most CLOUD_RETENTION_LIMIT total sections", () => {
    // Create CLOUD_RETENTION_LIMIT + 5 commit sections.
    const dir = commitsDir(repo);
    mkdirSync(dir, { recursive: true });
    const total = CLOUD_RETENTION_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(dir, `c${i.toString().padStart(4, "0")}.json`), "{}");
    }
    expect(readdirSync(dir).length).toBe(total);
    const pruned = pruneCloudSections(repo);
    expect(pruned).toBe(5);
    expect(readdirSync(dir).length).toBe(CLOUD_RETENTION_LIMIT);
  });

  it("no-op when under the limit", () => {
    const dir = commitsDir(repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "single.json"), "{}");
    expect(pruneCloudSections(repo)).toBe(0);
  });
});
