import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFleetUi } from "../scripts/fleet-ui-server";
let root: string, server: ReturnType<typeof startFleetUi>, base: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-ui-")));
  mkdirSync(join(root, "fleet")); mkdirSync(join(root, "metrics"));
  for (const [file, data] of Object.entries({ "targets.json": '{"codex-personal":2}', "holds.json": '{}',
    "jobs.jsonl": '{"job_id":"RQ-1","pool":"codex-personal","state":"running"}\n', "leader-events.jsonl": '' })) writeFileSync(join(root, "fleet", file), data);
  writeFileSync(join(root, "dispatch-events.log"), '{"type":"started","job_id":"RQ-1","private":"omitted"}\n');
  writeFileSync(join(root, "metrics/jobs.jsonl"), '{"status":"done","job_id":"other"}\n');
  server = startFleetUi({ root, port: 0 }); base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => { await server.stop(true); rmSync(root, { recursive: true, force: true }); });
const get = (path: string) => fetch(base + path);
test("graph connects jobs to lanes and preserves details; UI is served locally", async () => {
  const graph = await (await get('/api/graph')).json();
  expect(graph.nodes).toEqual([
    { id: 'lane:codex-personal', kind: 'lane', lane: 'codex-personal', details: { target: 2, hold: null } },
    { id: 'job:RQ-1', kind: 'job', lane: 'codex-personal', details: { job_id: 'RQ-1', pool: 'codex-personal', state: 'running' } },
  ]);
  expect(graph.links).toEqual([{ source: 'lane:codex-personal', target: 'job:RQ-1' }]);
  const page = await get('/'); expect(page.headers.get('content-type')).toContain('text/html');
  expect(await page.text()).toContain('/node-map.js');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
});
test("binds only IPv4 loopback and rejects hostile hosts, origins, methods and file paths", async () => {
  expect(server.hostname).toBe('127.0.0.1');
  for (const headers of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
    expect((await fetch(base + '/api/graph', { headers })).status).toBe(403);
    expect((await fetch(base + '/api/snapshot', { headers })).status).toBe(403);
  }
  expect((await fetch(base + '/api/graph', { method: 'POST' })).status).toBe(405);
  expect((await get('/.env')).status).toBe(404);
  expect((await get('/api/graph')).headers.get('access-control-allow-origin')).toBeNull();
});
test("log tail is bounded, job-filtered and never returns arbitrary record fields or paths", async () => {
  appendFileSync(join(root, 'dispatch-events.log'), '{"type":"finished","job_id":"RQ-1"}\n');
  const tail = await (await get('/api/log-tail?job=RQ-1&limit=1')).json();
  expect(tail.lines).toEqual([{ source: 'dispatch-events.log', line: 2, type: 'finished', timestamp: null, job_id: 'RQ-1' }]);
  expect(await (await get('/api/log-tail')).text()).not.toContain('omitted');
  expect((await (await get('/api/log-tail?job=../../.env')).json()).lines).toEqual([]);
  for (const limit of ['0', '201', 'NaN', '1.5']) expect((await get('/api/log-tail?limit=' + limit)).status).toBe(400);
});
test("event cursors reflect appends; missing and unsafe sources remain visible", async () => {
  const first = await (await get('/api/events')).json();
  appendFileSync(join(root, 'dispatch-events.log'), '{"type":"updated","job_id":"RQ-1"}\n');
  const next = await (await get('/api/events?cursor=' + first.cursor)).json();
  expect(next.events.map((event: { type: string }) => event.type)).toEqual(['updated']);
  expect((await get('/api/events?cursor=bad')).status).toBe(400);
  rmSync(join(root, 'dispatch-events.log')); symlinkSync(join(root, 'metrics/jobs.jsonl'), join(root, 'dispatch-events.log'));
  expect((await (await get('/api/log-tail')).json()).errors).toEqual({ 'dispatch-events.log': 'unsafe' });
  rmSync(join(root, 'fleet/targets.json'));
  expect((await (await get('/api/graph')).json()).errors).toEqual({ 'targets.json': 'missing' });
});
test("latest job state replaces earlier records for the same node", async () => {
  appendFileSync(join(root, 'fleet/jobs.jsonl'), '{"job_id":"RQ-1","pool":"codex-personal","state":"done"}\n');
  const graph = await (await get('/api/graph')).json();
  expect(graph.nodes.filter((node: { kind: string }) => node.kind === 'job')).toHaveLength(1);
  expect(graph.nodes.at(-1).details.state).toBe('done');
});

test("HTTP snapshot handles 500 jobs, aliases, deltas, and invalid cursor resync", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `job-${i}`, pool: "codex-personal", prUrl: `https://example.test/pr/${i}` }));
  writeFileSync(join(root, "fleet/jobs.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
  const firstResponse = await get('/api/snapshot');
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json();
  expect(Object.keys(first.jobs)).toHaveLength(500);
  expect(Object.keys(first.prs)).toHaveLength(500);
  expect(first.cursor).toMatch(/^[a-f0-9]{32}$/);
  appendFileSync(join(root, "fleet/jobs.jsonl"), '\n' + JSON.stringify({ ...rows[0], prUrl: 'https://example.test/pr/changed' }));
  const deltaResponse = await get('/api/snapshot?since=' + first.cursor);
  expect(deltaResponse.status).toBe(200);
  const delta = await deltaResponse.json();
  expect(Object.keys(delta.jobs)).toEqual(['job-0']);
  expect(delta.prs['job-0'].url).toBe('https://example.test/pr/changed');
  for (const id of ['', 'bad', '0'.repeat(32)]) expect((await get('/api/snapshot?since=' + id)).status).toBe(400);
  const second = startFleetUi({ root, port: 0 });
  try { expect((await fetch(`http://127.0.0.1:${second.port}/api/snapshot?since=${first.cursor}`)).status).toBe(400); }
  finally { await second.stop(true); }
  const resync = await (await get('/api/snapshot')).json();
  expect(Object.keys(resync.jobs)).toHaveLength(500);
  expect(Object.keys(resync.prs)).toHaveLength(500);
});

test("evicted HTTP cursors fail and a fresh request resynchronizes", async () => {
  const first = await (await get('/api/snapshot')).json();
  for (let i = 0; i < 64; i++) expect((await get('/api/snapshot')).status).toBe(200);
  expect((await get('/api/snapshot?since=' + first.cursor)).status).toBe(400);
  const fresh = await (await get('/api/snapshot')).json();
  expect(fresh.jobs['RQ-1'].state).toBe('running');
});
