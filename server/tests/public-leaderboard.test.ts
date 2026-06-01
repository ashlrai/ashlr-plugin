/**
 * public-leaderboard.test.ts
 *
 * Covers GET /public/leaderboard + the leaderboard_opt_in sync path:
 *   1. Shape + no auth needed
 *   2. ONLY opted-in users with a github_login appear (privacy gate)
 *   3. Ranked by tokens saved DESC; rank field is 1-based
 *   4. MAX-per-user dedup (multi-machine counted once)
 *   5. limit param clamps to 1..100
 *   6. Dollar conversion ($3/MTok)
 *   7. Never leaks email
 *   8. POST /stats/sync persists leaderboard_opt_in (in then out)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import { _resetPublicLeaderboardCache } from "../src/db/public-stats.js";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tier TEXT NOT NULL DEFAULT 'free',
      github_login TEXT,
      leaderboard_opt_in INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stats_uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      lifetime_calls INTEGER NOT NULL DEFAULT 0,
      lifetime_tokens_saved INTEGER NOT NULL DEFAULT 0,
      by_tool_json TEXT NOT NULL DEFAULT '{}',
      by_day_json TEXT NOT NULL DEFAULT '{}',
      machine_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);
  `);
  return db;
}

interface SeedOpts {
  email: string;
  token: string;
  login: string | null;
  optIn: boolean;
  uploads: Array<{ tokens: number; machine: string }>;
}

function seedUser(db: Database, o: SeedOpts): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO users (id, email, api_token, tier, github_login, leaderboard_opt_in)
     VALUES (?, ?, ?, 'pro', ?, ?)`,
    [id, o.email, o.token, o.login, o.optIn ? 1 : 0],
  );
  db.run(`INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`, [o.token, id]);
  for (const u of o.uploads) {
    db.run(
      `INSERT INTO stats_uploads (id, user_id, lifetime_tokens_saved, by_tool_json, by_day_json, machine_id)
       VALUES (?, ?, ?, '{}', '{}', ?)`,
      [crypto.randomUUID(), id, u.tokens, u.machine],
    );
  }
  return id;
}

async function getBoard(qs = ""): Promise<Response> {
  return app.fetch(new Request(`http://localhost/public/leaderboard${qs}`));
}

interface Entry {
  rank: number;
  handle: string;
  tokens_saved: number;
  dollars_saved: number;
}

describe("GET /public/leaderboard", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _resetPublicLeaderboardCache();
  });

  afterEach(() => {
    _resetDb();
    _resetPublicLeaderboardCache();
  });

  it("returns 200 + expected shape with no auth", async () => {
    const res = await getBoard();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Entry[]; last_updated_at: string };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.last_updated_at).toBe("string");
  });

  it("includes only opted-in users that have a github_login", async () => {
    seedUser(db, { email: "in@x.com", token: "tok-in-0000000000000000000000000", login: "alice", optIn: true, uploads: [{ tokens: 100, machine: "m1" }] });
    seedUser(db, { email: "out@x.com", token: "tok-out-000000000000000000000000", login: "bob", optIn: false, uploads: [{ tokens: 999, machine: "m1" }] });
    seedUser(db, { email: "nologin@x.com", token: "tok-nl-0000000000000000000000000", login: null, optIn: true, uploads: [{ tokens: 500, machine: "m1" }] });
    _resetPublicLeaderboardCache();

    const res = await getBoard();
    const body = (await res.json()) as { entries: Entry[] };
    expect(body.entries.map((e) => e.handle)).toEqual(["alice"]);
  });

  it("ranks by tokens saved DESC with 1-based rank", async () => {
    seedUser(db, { email: "a@x.com", token: "tok-a-00000000000000000000000000", login: "alice", optIn: true, uploads: [{ tokens: 100, machine: "m1" }] });
    seedUser(db, { email: "c@x.com", token: "tok-c-00000000000000000000000000", login: "carol", optIn: true, uploads: [{ tokens: 300, machine: "m1" }] });
    seedUser(db, { email: "b@x.com", token: "tok-b-00000000000000000000000000", login: "bob", optIn: true, uploads: [{ tokens: 200, machine: "m1" }] });
    _resetPublicLeaderboardCache();

    const res = await getBoard();
    const body = (await res.json()) as { entries: Entry[] };
    expect(body.entries.map((e) => [e.rank, e.handle])).toEqual([
      [1, "carol"],
      [2, "bob"],
      [3, "alice"],
    ]);
  });

  it("dedups multi-machine users to their MAX counter", async () => {
    seedUser(db, {
      email: "m@x.com", token: "tok-m-00000000000000000000000000", login: "max", optIn: true,
      uploads: [{ tokens: 100_000, machine: "A" }, { tokens: 80_000, machine: "B" }],
    });
    _resetPublicLeaderboardCache();

    const res = await getBoard();
    const body = (await res.json()) as { entries: Entry[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.tokens_saved).toBe(100_000);
  });

  it("converts dollars at $3/MTok", async () => {
    seedUser(db, { email: "d@x.com", token: "tok-d-00000000000000000000000000", login: "dee", optIn: true, uploads: [{ tokens: 1_000_000, machine: "m1" }] });
    _resetPublicLeaderboardCache();

    const res = await getBoard();
    const body = (await res.json()) as { entries: Entry[] };
    expect(body.entries[0]!.dollars_saved).toBe(3);
  });

  it("clamps limit to 1..100", async () => {
    for (let i = 0; i < 5; i++) {
      seedUser(db, {
        email: `u${i}@x.com`, token: `tok-${i}-0000000000000000000000000000`, login: `user${i}`, optIn: true,
        uploads: [{ tokens: (i + 1) * 10, machine: "m1" }],
      });
    }
    _resetPublicLeaderboardCache();

    const res = await getBoard("?limit=2");
    const body = (await res.json()) as { entries: Entry[] };
    expect(body.entries).toHaveLength(2);
  });

  it("sets Cache-Control and never leaks email", async () => {
    seedUser(db, { email: "secret@x.com", token: "tok-s-00000000000000000000000000", login: "shh", optIn: true, uploads: [{ tokens: 42, machine: "m1" }] });
    _resetPublicLeaderboardCache();

    const res = await getBoard();
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const text = await res.text();
    expect(text.includes("secret@x.com")).toBe(false);
    expect(text.includes("email")).toBe(false);
  });
});

describe("POST /stats/sync — leaderboard_opt_in persistence", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDb(db);
    _resetPublicLeaderboardCache();
  });

  afterEach(() => {
    _resetDb();
    _resetPublicLeaderboardCache();
  });

  async function sync(token: string, optIn?: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      apiToken: token,
      stats: { lifetime: { calls: 1, tokensSaved: 1000 } },
    };
    if (optIn !== undefined) body.leaderboard_opt_in = optIn;
    return app.fetch(
      new Request("http://localhost/stats/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  function optInValue(token: string): number {
    const row = db
      .query<{ v: number }, [string]>(
        `SELECT u.leaderboard_opt_in AS v FROM users u
         JOIN api_tokens t ON t.user_id = u.id WHERE t.token = ?`,
      )
      .get(token);
    return row?.v ?? -1;
  }

  // Note: /stats/sync is rate-limited to 1 req/10s per token, so each
  // transition uses a distinct token rather than two back-to-back syncs.
  it("turns opt-in ON when the client sends true", async () => {
    const token = "tok-on-0000000000000000000000000";
    seedUser(db, { email: "on@x.com", token, login: "on", optIn: false, uploads: [] });
    expect(optInValue(token)).toBe(0);

    const res = await sync(token, true);
    expect(res.status).toBe(200);
    expect(optInValue(token)).toBe(1);
  });

  it("turns opt-in OFF when the client sends false", async () => {
    const token = "tok-off-000000000000000000000000";
    seedUser(db, { email: "off@x.com", token, login: "off", optIn: true, uploads: [] });
    expect(optInValue(token)).toBe(1);

    const res = await sync(token, false);
    expect(res.status).toBe(200);
    expect(optInValue(token)).toBe(0);
  });

  it("leaves the existing setting untouched when the flag is absent", async () => {
    const token = "tok-keep-00000000000000000000000";
    seedUser(db, { email: "keep@x.com", token, login: "keep", optIn: true, uploads: [] });

    const res = await sync(token); // no flag
    expect(res.status).toBe(200);
    expect(optInValue(token)).toBe(1); // unchanged
  });
});
