/**
 * admin-discovery-propagation.test.ts — Tests for
 * GET /admin/discoveries/propagation.
 *
 * Covers (6 tests):
 *   1. Missing bearer  -> 401
 *   2. Wrong bearer    -> 401
 *   3. Env unset       -> 503
 *   4. Happy path      -> 200 with 2 rows ordered by session_count DESC
 *   5. sort=recent     -> reader called with "recent"; rows returned in
 *                          last_seen_at DESC order from the mock.
 *   6. limit=1         -> reader called with limit=1; one row returned.
 *
 * Mirrors admin-wad-d.test.ts shape (mock-reader injection via the
 * exported _setDiscoveryPropagationReader hook).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import {
  _setDiscoveryPropagationReader,
  type DiscoveryPropagationRow,
  type SortKey,
} from "../src/routes/admin-discovery-propagation.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const ENDPOINT = "/admin/discoveries/propagation";

function rowsBySessionCountDesc(): DiscoveryPropagationRow[] {
  return [
    {
      discovery_id: "high-reach",
      first_seen_at: "2026-05-01T10:00:00Z",
      last_seen_at: "2026-05-21T10:00:00Z",
      session_count: 9,
      distinct_identity_count: 4,
      last_aggregated_at: "2026-05-22T02:05:00Z",
    },
    {
      discovery_id: "low-reach",
      first_seen_at: "2026-05-20T10:00:00Z",
      last_seen_at: "2026-05-22T10:00:00Z",
      session_count: 2,
      distinct_identity_count: 1,
      last_aggregated_at: "2026-05-22T02:05:00Z",
    },
  ];
}

function rowsByRecentDesc(): DiscoveryPropagationRow[] {
  return [
    {
      discovery_id: "fresh",
      first_seen_at: "2026-05-22T10:00:00Z",
      last_seen_at: "2026-05-22T10:00:00Z",
      session_count: 1,
      distinct_identity_count: 1,
      last_aggregated_at: "2026-05-22T02:05:00Z",
    },
    {
      discovery_id: "stale",
      first_seen_at: "2026-05-01T10:00:00Z",
      last_seen_at: "2026-05-02T10:00:00Z",
      session_count: 7,
      distinct_identity_count: 3,
      last_aggregated_at: "2026-05-22T02:05:00Z",
    },
  ];
}

interface Call {
  limit: number;
  sort: SortKey;
}
let calls: Call[] = [];

function makeMockReader(): (
  limit: number,
  sort: SortKey,
) => DiscoveryPropagationRow[] {
  return (limit, sort) => {
    calls.push({ limit, sort });
    if (sort === "recent") {
      return rowsByRecentDesc().slice(0, limit);
    }
    return rowsBySessionCountDesc().slice(0, limit);
  };
}

function get(query: string = "", token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const url = query ? `${ENDPOINT}?${query}` : ENDPOINT;
  return app.request(url, { method: "GET", headers });
}

describe("GET /admin/discoveries/propagation", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    calls = [];
    _setDiscoveryPropagationReader(makeMockReader());
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setDiscoveryPropagationReader(null);
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.requestId).toBeDefined();
    expect(calls.length).toBe(0);
  });

  it("returns 401 when bearer token is wrong", async () => {
    const res = await get("", "definitely-not-the-token-and-same-length-ish");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("returns 503 (NOT 401) when server has no ASHLR_ADMIN_TRIGGER_TOKEN", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await get("", TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(calls.length).toBe(0);
  });

  it("returns 200 with rows sorted by session_count DESC on the happy path", async () => {
    const res = await get("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.sort).toBe("session_count");
    expect(calls[0]!.limit).toBe(50);

    const body = (await res.json()) as {
      discoveries: DiscoveryPropagationRow[];
      requestId: string;
    };
    expect(body.discoveries.length).toBe(2);
    expect(body.discoveries[0]!.discovery_id).toBe("high-reach");
    expect(body.discoveries[0]!.session_count).toBe(9);
    expect(body.discoveries[1]!.discovery_id).toBe("low-reach");
    expect(body.discoveries[1]!.session_count).toBe(2);
    expect(typeof body.requestId).toBe("string");
  });

  it("forwards sort=recent and returns rows in last_seen_at DESC", async () => {
    const res = await get("sort=recent", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.sort).toBe("recent");

    const body = (await res.json()) as {
      discoveries: DiscoveryPropagationRow[];
    };
    expect(body.discoveries.length).toBe(2);
    expect(body.discoveries[0]!.discovery_id).toBe("fresh");
    expect(body.discoveries[0]!.last_seen_at).toBe("2026-05-22T10:00:00Z");
    expect(body.discoveries[1]!.discovery_id).toBe("stale");
  });

  it("honors limit=1 (reader receives limit=1, one row returned)", async () => {
    const res = await get("limit=1", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.limit).toBe(1);

    const body = (await res.json()) as {
      discoveries: DiscoveryPropagationRow[];
    };
    expect(body.discoveries.length).toBe(1);
  });
});
