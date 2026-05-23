/**
 * admin-wad-d.test.ts — Tests for GET /admin/wad-d-snapshots.
 *
 * Covers:
 *   1.  Missing bearer header           -> 401
 *   2.  Wrong bearer                    -> 401
 *   3.  Different-length bearer         -> 401 (no crash)
 *   4.  Right bearer + token unset      -> 503 (NOT 401 — surface off)
 *   5.  Right bearer + token set        -> 200, snapshots returned in DESC order
 *   6.  Default days=30 when omitted
 *   7.  days cap at 365 (days=10000 -> reader called with 365)
 *   8.  Invalid/negative days -> default 30
 *
 * Mirrors admin-jobs.test.ts shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { _setDb, _resetDb } from "../src/db.js";
import {
  _setWadDSnapshotReader,
  type WadDSnapshotRow,
} from "../src/routes/admin-wad-d.js";

const TRIGGER_TOKEN = "test-trigger-token-1234567890abcdef";
const ENDPOINT = "/admin/wad-d-snapshots";

function fakeRows(): WadDSnapshotRow[] {
  return [
    {
      snapshot_date: "2026-05-22",
      wad_d_value: 7,
      lead_indicators_json: JSON.stringify({ identities_5d_plus: 7 }),
      computed_at: "2026-05-22T01:00:00Z",
    },
    {
      snapshot_date: "2026-05-21",
      wad_d_value: 6,
      lead_indicators_json: null,
      computed_at: "2026-05-21T01:00:00Z",
    },
  ];
}

type Call = { days: number };
let calls: Call[] = [];

function makeMockReader(rows: WadDSnapshotRow[] = fakeRows()) {
  return (days: number) => {
    calls.push({ days });
    return rows;
  };
}

function getSnapshots(query: string = "", token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const url = query ? `${ENDPOINT}?${query}` : ENDPOINT;
  return app.request(url, { method: "GET", headers });
}

describe("GET /admin/wad-d-snapshots", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    _setDb(db);
    calls = [];
    _setWadDSnapshotReader(makeMockReader());
    process.env["ASHLR_ADMIN_TRIGGER_TOKEN"] = TRIGGER_TOKEN;
  });

  afterEach(() => {
    _resetDb();
    _setWadDSnapshotReader(null); // restore default reader
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
  });

  // 1. Missing bearer -> 401
  it("returns 401 when Authorization header is missing", async () => {
    const res = await getSnapshots();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.requestId).toBeDefined();
    expect(calls.length).toBe(0);
  });

  // 2. Wrong bearer -> 401
  it("returns 401 when bearer token is wrong", async () => {
    const res = await getSnapshots("", "definitely-not-the-token-and-same-length-ish");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  // 3. Different-length bearer -> 401 cleanly
  it("rejects different-length bearer cleanly without crashing", async () => {
    const res = await getSnapshots("", "x");
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  // 4. Right bearer + token unset on server -> 503
  it("returns 503 (NOT 401) when server has no ASHLR_ADMIN_TRIGGER_TOKEN", async () => {
    delete process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];
    const res = await getSnapshots("", TRIGGER_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("disabled");
    expect(calls.length).toBe(0);
  });

  // 5. Right bearer -> 200, snapshots in DESC order, reader called once
  it("returns 200 with snapshots in DESC date order on valid bearer", async () => {
    const res = await getSnapshots("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const body = (await res.json()) as {
      snapshots: WadDSnapshotRow[];
      requestId: string;
    };
    expect(body.snapshots.length).toBe(2);
    expect(body.snapshots[0]!.snapshot_date).toBe("2026-05-22");
    expect(body.snapshots[0]!.wad_d_value).toBe(7);
    expect(body.snapshots[1]!.snapshot_date).toBe("2026-05-21");
    expect(typeof body.requestId).toBe("string");
  });

  // 6. Default days=30 when omitted
  it("defaults to 30 days when ?days is omitted", async () => {
    const res = await getSnapshots("", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.days).toBe(30);
  });

  // 7. days cap at 365
  it("caps ?days at 365 when caller asks for more", async () => {
    const res = await getSnapshots("days=10000", TRIGGER_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]!.days).toBe(365);
  });

  // 8. Invalid / negative days -> default 30
  it("falls back to 30 days for invalid or non-positive ?days", async () => {
    const res1 = await getSnapshots("days=-5", TRIGGER_TOKEN);
    expect(res1.status).toBe(200);
    expect(calls[0]!.days).toBe(30);

    calls = [];
    const res2 = await getSnapshots("days=abc", TRIGGER_TOKEN);
    expect(res2.status).toBe(200);
    expect(calls[0]!.days).toBe(30);
  });
});
