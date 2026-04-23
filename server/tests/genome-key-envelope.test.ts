/**
 * genome-key-envelope.test.ts — v2 envelope-encryption endpoints (Phase T1).
 *
 * Coverage:
 *   POST /user/genome-pubkey          — upload own X25519 pubkey
 *   GET  /user/genome-pubkey          — fetch own pubkey
 *   POST /genome/:id/key-envelope     — admin uploads wrapped DEK for member
 *   GET  /genome/:id/key-envelope     — member fetches own wrapped DEK
 *   GET  /genome/:id/key-envelopes    — admin audit view
 *   DELETE /genome/:id/key-envelope/:memberUserId — admin revoke
 *   GET  /genome/:id/members          — admin lists members + pubkeys
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import {
  _setDb,
  _resetDb,
  createUser,
  createTeam,
  setUserTier,
  upsertGenome,
  getDb,
} from "../src/db.js";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

// A valid base64url-encoded 32-byte X25519 pubkey (43 chars, no padding).
// Content doesn't have to be cryptographically meaningful — the server
// stores opaque bytes; the regex just checks shape.
const VALID_PUBKEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_PUBKEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Admin token + member token. Real tokens are long random strings; these are
// valid for the authMiddleware's lookup in the in-memory db.
const ADMIN_TOKEN  = "token-admin-0000000000000000000000";
const MEMBER_TOKEN = "token-member-000000000000000000000";

interface Fixture {
  adminId:  string;
  memberId: string;
  teamId:   string;
  genomeId: string;
}

function bootstrap(): Fixture {
  const admin  = createUser("admin@example.com",  ADMIN_TOKEN);
  const member = createUser("member@example.com", MEMBER_TOKEN);

  // Both need the `team` tier to hit the genome routes.
  setUserTier(admin.id,  "team");
  setUserTier(member.id, "team");

  const team = createTeam("Acme", admin.id);
  // createTeam adds admin as owner+admin. Add member directly.
  getDb().run(
    `INSERT INTO team_members (team_id, user_id, role, joined_at)
     VALUES (?, ?, 'member', datetime('now'))`,
    [team.id, member.id],
  );

  const { genome } = upsertGenome(team.id, "https://github.com/acme/widgets");
  return { adminId: admin.id, memberId: member.id, teamId: team.id, genomeId: genome.id };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` } as Record<string, string>;
}

async function post(path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return app.fetch(new Request("http://localhost" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

async function get(path: string, headers: Record<string, string>): Promise<Response> {
  return app.fetch(new Request("http://localhost" + path, { method: "GET", headers }));
}

async function del(path: string, headers: Record<string, string>): Promise<Response> {
  return app.fetch(new Request("http://localhost" + path, { method: "DELETE", headers }));
}

let f: Fixture;

beforeEach(() => {
  _setDb(makeTestDb());
  f = bootstrap();
});

afterEach(() => { _resetDb(); });

describe("POST/GET /user/genome-pubkey", () => {
  it("uploads and retrieves the caller's pubkey", async () => {
    const up = await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_A, alg: "x25519-v1" }, auth(ADMIN_TOKEN));
    expect(up.status).toBe(200);

    const got = await get("/user/genome-pubkey", auth(ADMIN_TOKEN));
    expect(got.status).toBe(200);
    const j = (await got.json()) as { pubkey: string; alg: string };
    expect(j.pubkey).toBe(VALID_PUBKEY_A);
    expect(j.alg).toBe("x25519-v1");
  });

  it("rejects malformed pubkeys", async () => {
    const r = await post("/user/genome-pubkey", { pubkey: "too-short", alg: "x25519-v1" }, auth(ADMIN_TOKEN));
    expect(r.status).toBe(400);
  });

  it("rejects unsupported algorithms", async () => {
    const r = await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_A, alg: "rsa-4096" }, auth(ADMIN_TOKEN));
    expect(r.status).toBe(400);
  });

  it("404 when no pubkey on file", async () => {
    const r = await get("/user/genome-pubkey", auth(MEMBER_TOKEN));
    expect(r.status).toBe(404);
  });
});

describe("POST /genome/:id/key-envelope (admin uploads for member)", () => {
  beforeEach(async () => {
    // Member has to have a pubkey before an admin can wrap to them.
    await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_B, alg: "x25519-v1" }, auth(MEMBER_TOKEN));
  });

  it("admin can upload an envelope for a team member", async () => {
    const r = await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: f.memberId, wrappedDek: "YWJjMTIz", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(ADMIN_TOKEN),
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; envelope: { member_user_id: string } };
    expect(j.ok).toBe(true);
    expect(j.envelope.member_user_id).toBe(f.memberId);
  });

  it("non-admin member cannot upload envelopes", async () => {
    const r = await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: f.memberId, wrappedDek: "YWJjMTIz", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(MEMBER_TOKEN),
    );
    expect(r.status).toBe(403);
  });

  it("rejects upload for a user not on the team", async () => {
    const stranger = createUser("stranger@example.com", "token-stranger-00000000000000000");
    setUserTier(stranger.id, "team");
    const r = await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: stranger.id, wrappedDek: "YWJjMTIz", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(ADMIN_TOKEN),
    );
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toContain("not on this team");
  });

  it("re-uploading replaces the existing envelope (key rotation)", async () => {
    await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: f.memberId, wrappedDek: "b2xkLWRlaw", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(ADMIN_TOKEN),
    );
    const r = await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: f.memberId, wrappedDek: "bmV3LWRlaw", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(ADMIN_TOKEN),
    );
    expect(r.status).toBe(200);

    const fetched = await get(`/genome/${f.genomeId}/key-envelope`, auth(MEMBER_TOKEN));
    const j = (await fetched.json()) as { wrappedDek: string; alg: string };
    expect(j.wrappedDek).toBe("bmV3LWRlaw");
  });
});

describe("GET /genome/:id/key-envelope (member fetches own)", () => {
  it("member can fetch their own envelope", async () => {
    await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_B, alg: "x25519-v1" }, auth(MEMBER_TOKEN));
    await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: f.memberId, wrappedDek: "bXktZGVr", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(ADMIN_TOKEN),
    );
    const r = await get(`/genome/${f.genomeId}/key-envelope`, auth(MEMBER_TOKEN));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { wrappedDek: string; alg: string };
    expect(j.wrappedDek).toBe("bXktZGVr");
    expect(j.alg).toBe("x25519-hkdf-sha256-aes256gcm-v1");
  });

  it("404 when no envelope exists for this member", async () => {
    const r = await get(`/genome/${f.genomeId}/key-envelope`, auth(MEMBER_TOKEN));
    expect(r.status).toBe(404);
  });
});

describe("GET /genome/:id/members (admin sees members + pubkeys)", () => {
  it("lists all team members with their pubkeys (or null if unset)", async () => {
    await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_A, alg: "x25519-v1" }, auth(ADMIN_TOKEN));
    await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_B, alg: "x25519-v1" }, auth(MEMBER_TOKEN));

    const r = await get(`/genome/${f.genomeId}/members`, auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      members: Array<{ userId: string; email: string; role: string; pubkey: string | null }>;
    };
    expect(j.members).toHaveLength(2);
    const byEmail = Object.fromEntries(j.members.map((m) => [m.email, m]));
    expect(byEmail["admin@example.com"]!.role).toBe("admin");
    expect(byEmail["admin@example.com"]!.pubkey).toBe(VALID_PUBKEY_A);
    expect(byEmail["member@example.com"]!.role).toBe("member");
    expect(byEmail["member@example.com"]!.pubkey).toBe(VALID_PUBKEY_B);
  });

  it("returns null pubkey for members who haven't uploaded one", async () => {
    const r = await get(`/genome/${f.genomeId}/members`, auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { members: Array<{ email: string; pubkey: string | null }> };
    for (const m of j.members) expect(m.pubkey).toBeNull();
  });
});

describe("DELETE /genome/:id/key-envelope/:memberUserId (admin revoke)", () => {
  beforeEach(async () => {
    await post("/user/genome-pubkey", { pubkey: VALID_PUBKEY_B, alg: "x25519-v1" }, auth(MEMBER_TOKEN));
    await post(
      `/genome/${f.genomeId}/key-envelope`,
      { memberUserId: f.memberId, wrappedDek: "YWJjMTIz", alg: "x25519-hkdf-sha256-aes256gcm-v1" },
      auth(ADMIN_TOKEN),
    );
  });

  it("admin can revoke a member's envelope", async () => {
    const r = await del(`/genome/${f.genomeId}/key-envelope/${f.memberId}`, auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);

    const after = await get(`/genome/${f.genomeId}/key-envelope`, auth(MEMBER_TOKEN));
    expect(after.status).toBe(404);
  });

  it("non-admin cannot revoke", async () => {
    const r = await del(`/genome/${f.genomeId}/key-envelope/${f.memberId}`, auth(MEMBER_TOKEN));
    expect(r.status).toBe(403);
  });
});
