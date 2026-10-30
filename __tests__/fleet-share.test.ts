import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetShare, mintShareToken, readShareToken, shareTokenMatches, shareTokenPath } from "../servers/fleet-share-server-handlers";
import { startFleetShare } from "../scripts/fleet-ui-server";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-share-")));
  mkdirSync(join(root, "fleet"), { recursive: true }); mkdirSync(join(root, "metrics"));
  for (const [file, data] of Object.entries({ "targets.json": '{"codex-personal":2}', "holds.json": '{}',
    "jobs.jsonl": '{"job_id":"RQ-1","pool":"codex-personal","state":"running"}\n', "leader-events.jsonl": '' })) writeFileSync(join(root, "fleet", file), data);
  writeFileSync(join(root, "dispatch-events.log"), '{"type":"started","job_id":"RQ-1"}\n');
  writeFileSync(join(root, "metrics/jobs.jsonl"), '{"status":"done","job_id":"other"}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Plainly fake token fixtures; real minting is covered separately below.
const FAKE_TOKEN = "fake-share-token-fixture";
const issue = (record: unknown = { token: FAKE_TOKEN, expires_at: new Date(Date.now() + 60_000).toISOString() }) =>
  writeFileSync(shareTokenPath(root), JSON.stringify(record));
const get = (path: string, init: RequestInit = {}) => fleetShare(new Request("http://share.test" + path, init), { root });
const authed = { authorization: `Bearer ${FAKE_TOKEN}` };

test("mint writes a time-boxed owner-only token and readShareToken round-trips it", () => {
  const now = new Date("2030-01-01T00:00:00Z"), minted = mintShareToken(root, { now });
  expect(minted.expires_at).toBe(new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  expect(statSync(shareTokenPath(root)).mode & 0o777).toBe(0o600);
  expect(readShareToken(root)).toEqual(minted);
  const rotated = mintShareToken(root, { now });
  expect(rotated.token).not.toBe(minted.token);
  expect(readShareToken(root)?.token).toBe(rotated.token);
  expect(statSync(shareTokenPath(root)).mode & 0o777).toBe(0o600);
});

test("token read fails closed on missing, malformed, linked or oversized records", () => {
  expect(readShareToken(root)).toBeNull();
  writeFileSync(shareTokenPath(root), "not json"); expect(readShareToken(root)).toBeNull();
  issue({ token: "", expires_at: "2999-01-01T00:00:00Z" }); expect(readShareToken(root)).toBeNull();
  issue({ token: FAKE_TOKEN, expires_at: "not-a-date" }); expect(readShareToken(root)).toBeNull();
  rmSync(shareTokenPath(root)); symlinkSync(join(root, "fleet/jobs.jsonl"), shareTokenPath(root));
  expect(readShareToken(root)).toBeNull();
});

test("shareTokenMatches is exact, length-safe and null-safe", () => {
  expect(shareTokenMatches("a", "a")).toBe(true);
  for (const [a, b] of [["b", "a"], ["aa", "a"], [null, "a"], ["", "a"], ["a", ""]] as [string | null, string][])
    expect(shareTokenMatches(a, b)).toBe(false);
});

test("GET state, session and events return read-only data behind a live bearer", async () => {
  issue();
  const state = await get("/share/state", { headers: authed }).json() as { targets: Record<string, number>; jobs: { job_id: string }[] };
  expect(state.targets).toEqual({ "codex-personal": 2 }); expect(state.jobs.at(-1)?.job_id).toBe("RQ-1");
  const session = await get("/share/session?job=RQ-1", { headers: authed }).json() as { job_id: string; job: { state: string } | null };
  expect(session.job?.state).toBe("running");
  const events = await get("/share/events", { headers: authed }).json() as { events: { type: string }[] };
  expect(events.events.map(event => event.type)).toEqual(["started", "done"]);
});

test("rejects missing, malformed, wrong and expired bearer tokens", () => {
  issue();
  const badHeaders: (Record<string, string> | undefined)[] = [undefined, {}, { authorization: "token x" }, { authorization: "Bearer" }, { authorization: `Bearer ${FAKE_TOKEN}-wrong` }, { authorization: `bearer ${FAKE_TOKEN}` }];
  for (const headers of badHeaders) expect(get("/share/state", { headers }).status).toBe(401);
  expect(get("/share/state?token=" + FAKE_TOKEN).status).toBe(401); // never a query credential
  issue({ token: FAKE_TOKEN, expires_at: new Date(Date.now() - 1).toISOString() });
  expect(get("/share/state", { headers: authed }).status).toBe(401); // expired
  issue({ token: FAKE_TOKEN, expires_at: new Date(Date.now() + 60_000).toISOString() });
  expect(fleetShare(new Request("http://share.test/share/state", { headers: authed }), { root, now: new Date(Date.now() + 120_000) }).status).toBe(401);
});

test("rejects every non-GET method and cross-site requests", () => {
  issue();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"])
    expect(get("/share/state", { method, headers: authed }).status).toBe(405);
  expect(get("/share/state", { method: "POST" }).status).toBe(401); // auth gate precedes the method check
  expect(get("/share/state", { headers: { ...authed, "sec-fetch-site": "cross-site" } }).status).toBe(403);
});

test("unknown paths in and out of the share scope are 404; bad params are 400", () => {
  issue();
  for (const path of ["/share/nope", "/share", "/api/graph", "/", "/share/state/extra"])
    expect(get(path, { headers: authed }).status).toBe(404);
  expect(get("/share/session", { headers: authed }).status).toBe(400); // job_id required
  expect(get("/share/session?job=../../etc", { headers: authed }).status).toBe(400);
  expect(get("/share/session?job=RQ-1&offset=1.5", { headers: authed }).status).toBe(400);
  expect(get("/share/events?cursor=bad", { headers: authed }).status).toBe(400);
  expect(get("/share/events?limit=999", { headers: authed }).status).toBe(400);
});

test("serves over real HTTP on the share listener only", async () => {
  issue();
  const server = startFleetShare({ root, port: 0, hostname: "127.0.0.1" }), base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(base + "/api/graph")).status).toBe(404); // loopback API is out of scope
    expect((await fetch(base + "/share/state")).status).toBe(401);
    expect((await fetch(base + "/share/state", { method: "POST", headers: authed })).status).toBe(405);
    const response = await fetch(base + "/share/state", { headers: authed });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as { jobs: { job_id: string }[] }).jobs.at(-1)?.job_id).toBe("RQ-1");
  } finally { await server.stop(true); }
});
