import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlPanel } from '../scripts/fleet-ui/control-panel.js';
import { startFleetUi } from '../scripts/fleet-ui-server';
const node = { id: 'job:RQ-1', kind: 'job', lane: 'codex', details: { job_id: 'RQ-1' } };
const targets = { pause: { lane: 'claude' }, resume: { lane: 'claude' }, kill: { job_id: 'RQ-1' }, reassign: { job_id: 'RQ-1', lane: 'claude' }, slots: { lane: 'claude', slots: 3 } };
test('every control confirms its exact structured payload and queues through fleetAct', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'controls-'))), server = startFleetUi({ root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`, logs: string[] = [];
  let confirmed = '';
  const run = createControlPanel(async body => {
    expect(body).toEqual({ confirmed: true, action: JSON.parse(confirmed) });
    const response = await fetch(base + '/api/actions', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(202); return response.json();
  }, message => { confirmed = message; return true; }, message => logs.push(message));
  try {
    for (const [action, target] of Object.entries(targets)) {
      await run(action, node, 'claude', '3', 'operator request');
      expect(JSON.parse(confirmed)).toEqual({ action, ...target, reason: 'operator request', requested_by: 'fleet-ui', dry_run: false });
    }
    const records = readFileSync(join(root, 'fleet/actions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.action)).toEqual(Object.keys(targets));
    expect(records.every(record => record.status === 'pending')).toBe(true);
    expect(logs).toHaveLength(5); expect(logs.every(line => line.includes('pending'))).toBe(true);
    expect((await fetch(base + '/control-panel.js')).status).toBe(200);
    const html = await (await fetch(base)).text();
    for (const action of Object.keys(targets)) expect(html).toContain(`data-fleet-action="${action}"`);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
test('cancellation, invalid values, duplicate clicks and transport failures are safe and logged', async () => {
  let sends = 0, confirms = 0;
  const logs: string[] = [];
  const cancelled = createControlPanel(async () => { sends++; }, () => { confirms++; return false; }, message => logs.push(message));
  for (const action of Object.keys(targets)) await cancelled(action, node, 'claude', '3', 'reason');
  expect(sends).toBe(0); expect(confirms).toBe(5); expect(logs.every(line => line.includes('cancelled'))).toBe(true);
  for (const [action, lane, slots, reason] of [['slots', 'codex', '', 'reason'], ['slots', 'codex', '1025', 'reason'], ['pause', '../bad', '1', 'reason'], ['kill', 'codex', '1', ''], ['unknown', 'codex', '1', 'reason']]) await cancelled(action!, node, lane!, slots!, reason!);
  expect(confirms).toBe(5);
  let release!: (value: boolean) => void;
  const pending = createControlPanel(async () => { sends++; throw Error('offline'); }, () => new Promise(resolve => { release = resolve; }), message => logs.push(message));
  const first = pending('kill', node, 'codex', '1', 'reason');
  await pending('kill', node, 'codex', '1', 'reason'); release(true); await first;
  expect(sends).toBe(1); expect(logs.at(-1)).toContain('failed · offline');
});
test('HTTP actions require same-origin JSON and explicit confirmation; rejected actions never append', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'controls-'))), server = startFleetUi({ root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const action = { action: 'kill', job_id: 'RQ-1', requested_by: 'fleet-ui', reason: 'reason', dry_run: false };
  try {
    for (const [origin, type, body, status] of [[undefined, 'application/json', { confirmed: true, action }, 403], ['https://evil.example', 'application/json', { confirmed: true, action }, 403], [base, 'text/plain', { confirmed: true, action }, 403], [base, 'application/json', { action }, 400], [base, 'application/json', { confirmed: false, action }, 400], [base, 'application/json', { confirmed: true, action: { ...action, job_id: '../bad' } }, 400]] as const) {
      const headers: Record<string, string> = { 'content-type': type }; if (origin) headers.origin = origin;
      expect((await fetch(base + '/api/actions', { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(status);
    }
    expect(existsSync(join(root, 'fleet/actions.jsonl'))).toBe(false);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
