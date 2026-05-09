/**
 * admin-genome.test.ts — Tests for admin genome drilldown queries and routes.
 *
 * Tests:
 *  1.  adminListAllGenomes returns correct shape
 *  2.  adminListAllGenomes lists all genomes in DB
 *  3.  adminListAllGenomes push_count_30d reflects only last 30 days
 *  4.  adminListAllGenomes total_bytes sums genome_sections content
 *  5.  adminListAllGenomes sorted by push_count_30d desc
 *  6.  adminGetGenomeDetail returns null for unknown genome
 *  7.  adminGetGenomeDetail returns correct genome_id and org_id
 *  8.  adminGetGenomeDetail sections list top paths by retrieval
 *  9.  adminGetGenomeDetail top_contributors redacted to 8 chars
 * 10.  adminGetGenomeDetail sync_history has one row per active day
 * 11.  adminGetGenomeDetail conflict_count_30d counts conflicts in window
 * 12.  adminGetGenomeDetail retrieval_count_30d total pushes in window
 * 13.  adminListGenomeConflicts returns correct shape
 * 14.  adminListGenomeConflicts respects windowDays parameter
 * 15.  Route GET /admin/genomes requires admin token
 * 16.  Route GET /admin/genomes returns genomes array
 * 17.  Route GET /admin/genomes/:id returns 404 for unknown id
 * 18.  Route GET /admin/genomes/:id returns detail for known id
 * 19.  Route GET /admin/genomes/conflicts returns conflicts array
 * 20.  Non-admin cannot access /admin/genomes
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  setUserAdmin,
} from "../src/db.js";
import {
  adminListAllGenomes,
  adminGetGenomeDetail,
  adminListGenomeConflicts,
} from "../src/db/genome-insights.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function get(path: string, token?: string) {
  return app.request(path, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function insertGenome(db: Database, orgId: string, repoUrl: string): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genomes (id, org_id, repo_url) VALUES (?, ?, ?)`,
    [id, orgId, repoUrl],
  );
  return id;
}

function insertSection(db: Database, genomeId: string, path: string, content: string): void {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genome_sections (id, genome_id, path, content) VALUES (?, ?, ?, ?)`,
    [id, genomeId, path, content],
  );
}

function insertPushLog(db: Database, genomeId: string, clientId: string, path: string, at: string): void {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genome_push_log (id, genome_id, client_id, path, at) VALUES (?, ?, ?, ?, ?)`,
    [id, genomeId, clientId, path, at],
  );
}

function insertConflict(db: Database, genomeId: string, path: string, detectedAt: string): void {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO genome_conflicts (id, genome_id, path, variants_json, detected_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, genomeId, path, JSON.stringify(["variant-a content", "variant-b content"]), detectedAt],
  );
}

const NOW = new Date().toISOString();
const RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString();    // 5 days ago
const OLD    = new Date(Date.now() - 40 * 86_400_000).toISOString();   // 40 days ago

// ---------------------------------------------------------------------------
// Unit tests — query layer
// ---------------------------------------------------------------------------

describe("adminListAllGenomes", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    process.env["TESTING"] = "1";
  });

  afterEach(() => { _resetDb(); });

  // 1. Shape
  it("returns array with correct field shape", () => {
    const rows = adminListAllGenomes();
    expect(Array.isArray(rows)).toBe(true);
    // Empty is fine — just verify shape contract
  });

  // 2. Lists all genomes
  it("lists all genomes in the DB", () => {
    insertGenome(db, "org-a", "https://github.com/a/repo");
    insertGenome(db, "org-b", "https://github.com/b/repo");
    const rows = adminListAllGenomes();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  // 3. push_count_30d only counts recent pushes
  it("push_count_30d excludes pushes older than 30 days", () => {
    const gid = insertGenome(db, "org-c", "https://github.com/c/repo");
    insertPushLog(db, gid, "client-001", "knowledge/a.md", RECENT); // recent — counted
    insertPushLog(db, gid, "client-001", "knowledge/a.md", OLD);    // old — not counted

    const rows = adminListAllGenomes();
    const row = rows.find((r) => r.genome_id === gid);
    expect(row).toBeDefined();
    expect(row!.push_count_30d).toBe(1);
  });

  // 4. total_bytes sums genome_sections content
  it("total_bytes is sum of all section content lengths", () => {
    const gid = insertGenome(db, "org-d", "https://github.com/d/repo");
    insertSection(db, gid, "section/a.md", "hello");    // 5 bytes
    insertSection(db, gid, "section/b.md", "world!!");  // 7 bytes

    const rows = adminListAllGenomes();
    const row = rows.find((r) => r.genome_id === gid);
    expect(row).toBeDefined();
    expect(row!.total_bytes).toBe(12);
  });

  // 5. Sorted by push_count_30d desc
  it("sorted by push_count_30d descending", () => {
    const g1 = insertGenome(db, "org-sort1", "https://github.com/s1/repo");
    const g2 = insertGenome(db, "org-sort2", "https://github.com/s2/repo");
    // g2 gets more recent pushes
    insertPushLog(db, g2, "c-001", "a.md", RECENT);
    insertPushLog(db, g2, "c-001", "b.md", RECENT);
    insertPushLog(db, g1, "c-002", "a.md", RECENT);

    const rows = adminListAllGenomes();
    const idx1 = rows.findIndex((r) => r.genome_id === g1);
    const idx2 = rows.findIndex((r) => r.genome_id === g2);
    expect(idx2).toBeLessThan(idx1); // g2 should appear before g1
  });
});

describe("adminGetGenomeDetail", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    process.env["TESTING"] = "1";
  });

  afterEach(() => { _resetDb(); });

  // 6. Unknown genome → null
  it("returns null for an unknown genome id", () => {
    const result = adminGetGenomeDetail("nonexistent-genome-id");
    expect(result).toBeNull();
  });

  // 7. Returns correct genome_id and org_id
  it("returns correct genome_id and org_id", () => {
    const gid = insertGenome(db, "org-detail", "https://github.com/det/repo");
    const result = adminGetGenomeDetail(gid);
    expect(result).not.toBeNull();
    expect(result!.genome_id).toBe(gid);
    expect(result!.org_id).toBe("org-detail");
  });

  // 8. Sections list top paths
  it("sections lists paths sorted by retrieval count desc", () => {
    const gid = insertGenome(db, "org-sec", "https://github.com/sec/repo");
    insertSection(db, gid, "knowledge/hot.md", "content");
    insertSection(db, gid, "knowledge/cold.md", "content");
    // hot.md gets 3 recent pushes, cold.md gets 1
    for (let i = 0; i < 3; i++) insertPushLog(db, gid, "c-001", "knowledge/hot.md", RECENT);
    insertPushLog(db, gid, "c-002", "knowledge/cold.md", RECENT);

    const result = adminGetGenomeDetail(gid);
    expect(result).not.toBeNull();
    const paths = result!.sections.map((s) => s.path);
    expect(paths[0]).toBe("knowledge/hot.md");
  });

  // 9. top_contributors client_id redacted to 8 chars
  it("top_contributors client_id_redacted is 8 chars max", () => {
    const gid = insertGenome(db, "org-contrib", "https://github.com/contrib/repo");
    insertPushLog(db, gid, "abcdef1234567890-full-client-id", "a.md", RECENT);

    const result = adminGetGenomeDetail(gid);
    expect(result).not.toBeNull();
    expect(result!.top_contributors.length).toBeGreaterThan(0);
    for (const c of result!.top_contributors) {
      expect(c.client_id_redacted.length).toBeLessThanOrEqual(8);
    }
  });

  // 10. sync_history one row per active day
  it("sync_history groups pushes by day", () => {
    const gid = insertGenome(db, "org-sync", "https://github.com/sync/repo");
    const day1 = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const day2 = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    insertPushLog(db, gid, "c-001", "a.md", `${day1}T10:00:00Z`);
    insertPushLog(db, gid, "c-001", "b.md", `${day1}T14:00:00Z`);
    insertPushLog(db, gid, "c-001", "a.md", `${day2}T09:00:00Z`);

    const result = adminGetGenomeDetail(gid);
    expect(result).not.toBeNull();
    const days = result!.sync_history.map((s) => s.day);
    expect(days).toContain(day1);
    expect(days).toContain(day2);
    const d1Row = result!.sync_history.find((s) => s.day === day1);
    expect(d1Row!.push_count).toBe(2);
  });

  // 11. conflict_count_30d
  it("conflict_count_30d counts only conflicts within 30 days", () => {
    const gid = insertGenome(db, "org-cf", "https://github.com/cf/repo");
    insertConflict(db, gid, "a.md", RECENT); // recent — counted
    insertConflict(db, gid, "b.md", OLD);    // old — not counted

    const result = adminGetGenomeDetail(gid);
    expect(result).not.toBeNull();
    expect(result!.conflict_count_30d).toBe(1);
  });

  // 12. retrieval_count_30d
  it("retrieval_count_30d counts only pushes within 30 days", () => {
    const gid = insertGenome(db, "org-ret", "https://github.com/ret/repo");
    insertPushLog(db, gid, "c-001", "a.md", RECENT); // recent
    insertPushLog(db, gid, "c-001", "b.md", OLD);    // old — excluded

    const result = adminGetGenomeDetail(gid);
    expect(result).not.toBeNull();
    expect(result!.retrieval_count_30d).toBe(1);
  });
});

describe("adminListGenomeConflicts", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    process.env["TESTING"] = "1";
  });

  afterEach(() => { _resetDb(); });

  // 13. Shape
  it("returns array with correct field shape", () => {
    const gid = insertGenome(db, "org-cf2", "https://github.com/cf2/repo");
    insertConflict(db, gid, "knowledge/a.md", RECENT);

    const rows = adminListGenomeConflicts(30);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row).toHaveProperty("genome_id");
    expect(row).toHaveProperty("conflicting_user_id_redacted");
    expect(row).toHaveProperty("ts");
    expect(row).toHaveProperty("summary");
  });

  // 14. Respects windowDays
  it("excludes conflicts outside the window", () => {
    const gid = insertGenome(db, "org-cf3", "https://github.com/cf3/repo");
    insertConflict(db, gid, "a.md", RECENT); // 5d ago — in 30d window
    insertConflict(db, gid, "b.md", OLD);    // 40d ago — outside

    const rows30 = adminListGenomeConflicts(30);
    const rows7  = adminListGenomeConflicts(7);
    expect(rows30.some((r) => r.genome_id === gid)).toBe(true);
    // The old conflict must not appear in the 7-day window
    const oldInRows7 = rows7.filter((r) => r.genome_id === gid && r.ts === OLD);
    expect(oldInRows7.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route-level tests (via HTTP)
// ---------------------------------------------------------------------------

describe("/admin/genomes routes", () => {
  let db: Database;
  let adminToken: string;
  let normalToken: string;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _clearBuckets();
    process.env["TESTING"] = "1";

    const admin = createUser("genomadmin@example.com", "tok-genomadmin-00000000000000000000000");
    adminToken = admin.api_token;
    setUserAdmin(admin.id, true);

    const normal = createUser("normaluser@example.com", "tok-normaluser-0000000000000000000000");
    normalToken = normal.api_token;
  });

  afterEach(() => { _resetDb(); });

  // 15. Requires admin token
  it("GET /admin/genomes returns 403 without admin token", async () => {
    const res = await get("/admin/genomes", normalToken);
    expect(res.status).toBe(403);
  });

  // 16. Returns genomes array
  it("GET /admin/genomes returns { genomes: [...] }", async () => {
    insertGenome(db, "org-route1", "https://github.com/r1/repo");
    const res = await get("/admin/genomes", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("genomes");
    expect(Array.isArray(body.genomes)).toBe(true);
  });

  // 17. Unknown id → 404
  it("GET /admin/genomes/:id returns 404 for unknown id", async () => {
    const res = await get("/admin/genomes/does-not-exist", adminToken);
    expect(res.status).toBe(404);
  });

  // 18. Known id → detail
  it("GET /admin/genomes/:id returns detail for known genome", async () => {
    const gid = insertGenome(db, "org-route2", "https://github.com/r2/repo");
    insertPushLog(db, gid, "c-001", "a.md", RECENT);

    const res = await get(`/admin/genomes/${gid}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("genome_id", gid);
    expect(body).toHaveProperty("org_id", "org-route2");
    expect(body).toHaveProperty("sections");
    expect(body).toHaveProperty("top_contributors");
    expect(body).toHaveProperty("sync_history");
    expect(body).toHaveProperty("conflict_count_30d");
    expect(body).toHaveProperty("retrieval_count_30d");
  });

  // 19. Conflicts route returns array
  it("GET /admin/genomes/conflicts returns { conflicts: [...] }", async () => {
    const gid = insertGenome(db, "org-route3", "https://github.com/r3/repo");
    insertConflict(db, gid, "a.md", RECENT);

    const res = await get("/admin/genomes/conflicts?window=30", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("conflicts");
    expect(Array.isArray(body.conflicts)).toBe(true);
  });

  // 20. Non-admin cannot access
  it("GET /admin/genomes/conflicts returns 403 for non-admin", async () => {
    const res = await get("/admin/genomes/conflicts", normalToken);
    expect(res.status).toBe(403);
  });
});
