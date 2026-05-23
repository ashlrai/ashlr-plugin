/**
 * admin-sessions.test.ts — Tests for GET /admin/sessions and
 * GET /admin/sessions/:session_id_hash.
 *
 * Q4 session replay UI READ surface. Mirrors admin-wad-d.test.ts shape.
 *
 * Covers:
 *   1.  Missing bearer header on list             -> 401
 *   2.  Wrong bearer on list                      -> 401
 *   3.  Different-length bearer on list           -> 401 (no crash)
 *   4.  Right bearer + token unset on server      -> 503 (NOT 401)
 *   5.  Right bearer + list happy path            -> 200, hash prefixes only,
 *                                                    total_count_in_window
 *   6.  days cap at 90                            -> reader called with 90
 *   7.  limit cap at 200                          -> reader called with 200
 *   8.  logged_in=true / false filter passthrough -> reader gets loggedIn
 *   9.  Detail happy path                         -> 200 with related list
 *  10.  Detail unknown id                         -> 404 (not 403)
 *  11.  Detail malformed id (not hex64)           -> 404 (no shape leak)
 *  12.  Detail missing bearer                     -> 401
 *  13.  Related list scoped to same identity      -> excludes other identities
 *                                                    and the target itself
 *
 * The reader is swapped via the _setSession*Reader exports — same DI pattern
 * as admin-wad-d.test.ts. Tests do NOT touch a real DB schema.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import {
  _setSessionListReader,
  _setSessionDetailReader,
  _setSessionRelatedReader,
  type SessionEventRow,
  type ListFilter,
} from "../src/routes/admin-sessions.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const LIST_ENDPOINT = "/admin/sessions";

const IDENTITY_A = "a".repeat(64);
const IDENTITY_B = "b".repeat(64);
const GITHUB_A   = "1".repeat(64);
const SESSION_1  = "c".repeat(64);
const SESSION_2  = "d".repeat(64);
const SESSION_3  = "e".repeat(64);

function row(overrides: Partial<SessionEventRow> = {}): SessionEventRow {
  return {
    session_id_hash:     SESSION_1,
    identity_hash:       IDENTITY_A,
    github_hash:         GITHUB_A,
    ended_at:            "2026-05-22T12:00:00Z",
    tool_count:          42,
    tokens_saved:        12_345,
    branch_sha:          "abc123def456",
    discovery_refs_json: JSON.stringify(["auth-jwt-flow", "rate-limit-buckets"]),
    ...overrides,
  };
}

type ListCall = { filter: ListFilter };
type DetailCall = { sessionIdHash: string };
type RelatedCall = { identityHash: string; excludeSessionIdHash: string; days: number };

let listCalls: ListCall[] = [];
let detailCalls: DetailCall[] = [];
let relatedCalls: RelatedCall[] = [];

function makeListReader(opts: {
  sessions?: SessionEventRow[];
  total?: number;
} = {}) {
  return (filter: ListFilter) => {
    listCalls.push({ filter });
    const sessions = opts.sessions ?? [row({ session_id_hash: SESSION_1 }), row({ session_id_hash: SESSION_2, github_hash: null })];
    return { sessions, total: opts.total ?? sessions.length };
  };
}

function makeDetailReader(map: Record<string, SessionEventRow | null>) {
  return (sessionIdHash: string) => {
    detailCalls.push({ sessionIdHash });
    return map[sessionIdHash] ?? null;
  };
}

function makeRelatedReader(rows: SessionEventRow[]) {
  return (identityHash: string, excludeSessionIdHash: string, days: number) => {
    relatedCalls.push({ identityHash, excludeSessionIdHash, days });
    return rows;
  };
}

function get(path: string, token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return app.request(path, { method: "GET", headers });
}

describe("GET /admin/sessions (list)", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    listCalls = [];
    detailCalls = [];
    relatedCalls = [];
    _setSessionListReader(makeListReader());
    _setSessionDetailReader(makeDetailReader({}));
    _setSessionRelatedReader(makeRelatedReader([]));
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setSessionListReader(null);
    _setSessionDetailReader(null);
    _setSessionRelatedReader(null);
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  // 1. Missing bearer -> 401
  it("returns 401 when Authorization header is missing", async () => {
    const res = await get(LIST_ENDPOINT);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.requestId).toBeDefined();
    expect(listCalls.length).toBe(0);
  });

  // 2. Wrong bearer -> 401
  it("returns 401 when bearer token is wrong", async () => {
    const res = await get(LIST_ENDPOINT, "definitely-not-the-token-and-same-length-ish");
    expect(res.status).toBe(401);
    expect(listCalls.length).toBe(0);
  });

  // 3. Different-length bearer rejected cleanly
  it("rejects different-length bearer without crashing", async () => {
    const res = await get(LIST_ENDPOINT, "x");
    expect(res.status).toBe(401);
    expect(listCalls.length).toBe(0);
  });

  // 4. Token unset on server -> 503
  it("returns 503 (NOT 401) when ASHLR_ADMIN_TRIGGER_TOKEN is unset", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await get(LIST_ENDPOINT, TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(listCalls.length).toBe(0);
  });

  // 5. List happy path — returns hash prefixes only
  it("returns 200 with hash-prefix-only sessions on valid bearer", async () => {
    const res = await get(LIST_ENDPOINT, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        session_id_hash: string;
        identity_hash_prefix: string;
        github_hash_prefix: string | null;
        discovery_refs: string[];
      }>;
      total_count_in_window: number;
      requestId: string;
    };
    expect(body.sessions.length).toBe(2);

    // identity_hash_prefix must be 8 chars, not the full 64-char hash.
    expect(body.sessions[0]!.identity_hash_prefix.length).toBe(8);
    expect(body.sessions[0]!.identity_hash_prefix).toBe(IDENTITY_A.slice(0, 8));
    // Github hash prefix is 8 chars when present, null when anonymous.
    expect(body.sessions[0]!.github_hash_prefix).toBe(GITHUB_A.slice(0, 8));
    expect(body.sessions[1]!.github_hash_prefix).toBeNull();

    // discovery_refs are parsed from JSON.
    expect(body.sessions[0]!.discovery_refs).toEqual([
      "auth-jwt-flow",
      "rate-limit-buckets",
    ]);

    // No raw identity_hash leaked anywhere in the payload.
    const wire = JSON.stringify(body);
    expect(wire.includes(IDENTITY_A)).toBe(false);

    expect(body.total_count_in_window).toBe(2);
    expect(typeof body.requestId).toBe("string");
  });

  // 6. days cap at 90
  it("caps ?days at 90", async () => {
    const res = await get(`${LIST_ENDPOINT}?days=10000`, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(listCalls[0]!.filter.days).toBe(90);
  });

  // 7. limit cap at 200
  it("caps ?limit at 200", async () => {
    const res = await get(`${LIST_ENDPOINT}?limit=99999`, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(listCalls[0]!.filter.limit).toBe(200);
  });

  // 8. logged_in filter passthrough
  it("threads logged_in=true / false through to the reader", async () => {
    const res1 = await get(`${LIST_ENDPOINT}?logged_in=true`, TRIGGER_TOKEN);
    expect(res1.status).toBe(200);
    expect(listCalls[0]!.filter.loggedIn).toBe(true);

    listCalls = [];
    const res2 = await get(`${LIST_ENDPOINT}?logged_in=false`, TRIGGER_TOKEN);
    expect(res2.status).toBe(200);
    expect(listCalls[0]!.filter.loggedIn).toBe(false);

    listCalls = [];
    const res3 = await get(`${LIST_ENDPOINT}?logged_in=banana`, TRIGGER_TOKEN);
    expect(res3.status).toBe(200);
    expect(listCalls[0]!.filter.loggedIn).toBeNull();
  });
});

describe("GET /admin/sessions/:session_id_hash (detail)", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    listCalls = [];
    detailCalls = [];
    relatedCalls = [];
    _setSessionListReader(makeListReader());
    _setSessionDetailReader(makeDetailReader({}));
    _setSessionRelatedReader(makeRelatedReader([]));
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setSessionListReader(null);
    _setSessionDetailReader(null);
    _setSessionRelatedReader(null);
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  // 9. Detail happy path
  it("returns 200 with the session plus related identity sessions", async () => {
    const target = row({ session_id_hash: SESSION_1, identity_hash: IDENTITY_A });
    const sibling = row({
      session_id_hash: SESSION_2,
      identity_hash: IDENTITY_A,
      ended_at: "2026-05-21T10:00:00Z",
    });
    _setSessionDetailReader(makeDetailReader({ [SESSION_1]: target }));
    _setSessionRelatedReader(makeRelatedReader([sibling]));

    const res = await get(`${LIST_ENDPOINT}/${SESSION_1}`, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { session_id_hash: string; identity_hash_prefix: string };
      related: Array<{ session_id_hash: string; identity_hash_prefix: string }>;
    };
    expect(body.session.session_id_hash).toBe(SESSION_1);
    expect(body.session.identity_hash_prefix).toBe(IDENTITY_A.slice(0, 8));
    expect(body.related.length).toBe(1);
    expect(body.related[0]!.session_id_hash).toBe(SESSION_2);
    expect(body.related[0]!.identity_hash_prefix).toBe(IDENTITY_A.slice(0, 8));

    // No raw identity_hash leaked.
    const wire = JSON.stringify(body);
    expect(wire.includes(IDENTITY_A)).toBe(false);

    // Related reader was called with the target identity and asked to
    // exclude the target session_id_hash.
    expect(relatedCalls.length).toBe(1);
    expect(relatedCalls[0]!.identityHash).toBe(IDENTITY_A);
    expect(relatedCalls[0]!.excludeSessionIdHash).toBe(SESSION_1);
    expect(relatedCalls[0]!.days).toBe(30);
  });

  // 10. Unknown id -> 404 (not 403)
  it("returns 404 (NOT 403) when session_id_hash is unknown", async () => {
    _setSessionDetailReader(makeDetailReader({})); // empty map => null
    const res = await get(`${LIST_ENDPOINT}/${SESSION_3}`, TRIGGER_TOKEN);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
    // Related reader was NOT called — we never reached "this session exists."
    expect(relatedCalls.length).toBe(0);
  });

  // 11. Malformed id -> 404 with no schema leak
  it("returns 404 for malformed session_id_hash (no shape leak)", async () => {
    const res = await get(`${LIST_ENDPOINT}/not-a-hash`, TRIGGER_TOKEN);
    expect(res.status).toBe(404);
    // Detail reader was NOT called — we rejected before DB.
    expect(detailCalls.length).toBe(0);
  });

  // 12. Missing bearer on detail -> 401
  it("returns 401 on detail when bearer is missing", async () => {
    const res = await get(`${LIST_ENDPOINT}/${SESSION_1}`);
    expect(res.status).toBe(401);
    expect(detailCalls.length).toBe(0);
  });

  // 13. Related list is scoped to the same identity_hash
  it("scopes related sessions to the same identity_hash and excludes the target", async () => {
    // Set up a target with identity A. The "related" reader returns 2
    // siblings — both must be from identity A, and neither should be the
    // target session. The route never sees the OTHER identity's sessions
    // because the reader scopes them server-side; this test verifies the
    // reader contract (identity + exclude) is honored.
    const target = row({ session_id_hash: SESSION_1, identity_hash: IDENTITY_A });
    const siblingA = row({
      session_id_hash: SESSION_2,
      identity_hash: IDENTITY_A,
      ended_at: "2026-05-20T09:00:00Z",
    });
    const siblingB = row({
      session_id_hash: SESSION_3,
      identity_hash: IDENTITY_A,
      ended_at: "2026-05-19T08:00:00Z",
    });
    _setSessionDetailReader(makeDetailReader({ [SESSION_1]: target }));
    _setSessionRelatedReader(
      makeRelatedReader([siblingA, siblingB]),
    );

    const res = await get(`${LIST_ENDPOINT}/${SESSION_1}`, TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      related: Array<{ session_id_hash: string; identity_hash_prefix: string }>;
    };
    expect(body.related.length).toBe(2);
    // All related rows share the same identity-hash prefix.
    const prefixes = new Set(body.related.map((r) => r.identity_hash_prefix));
    expect(prefixes.size).toBe(1);
    expect(prefixes.has(IDENTITY_A.slice(0, 8))).toBe(true);
    // The target session_id_hash itself is NOT in the related list — that's
    // the reader's contract; we assert the API surface forwards it.
    expect(body.related.some((r) => r.session_id_hash === SESSION_1)).toBe(false);
    // Sanity: we did NOT accidentally surface a different identity (B).
    expect(prefixes.has(IDENTITY_B.slice(0, 8))).toBe(false);
  });
});
