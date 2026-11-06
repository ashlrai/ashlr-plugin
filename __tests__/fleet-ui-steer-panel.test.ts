import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFleetUi } from '../scripts/fleet-ui-server';
import { mountSteerPanel } from '../scripts/fleet-ui/steer-panel.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'steer-ui-')));
  mkdirSync(join(root, 'fleet'));
  const slots = join(root, 'fleet/slots.json'), journal = join(root, 'fleet/steer-proposals.jsonl');
  writeFileSync(slots, '{"codex":2}\n');
  const server = startFleetUi({ root, port: 0 }), base = `http://127.0.0.1:${server.port}`;
  cleanups.push(async () => { await server.stop(true); rmSync(root, { recursive: true, force: true }); });
  const headers = { origin: base, 'content-type': 'application/json' };
  const post = (body: unknown, extra = {}) => fetch(base + '/api/steer', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { root, base, slots, journal, post };
}
const proposal = { confirmed: true, action: 'set-slots', lane: 'codex', slots: 3, author: 'Mason', reason: 'rebalance' };

test('mounted session steering proposes both actions, displays pending proposals and refuses duplicates', async () => {
  const { root, base, slots, journal } = fixture();
  const elements: Record<string, any> = {};
  for (const id of ['lane', 'slots', 'author', 'reason', 'pending', 'status', 'refresh']) elements['#steer-' + id] = { value: '', textContent: '' };
  const buttons = ['reassign', 'set-slots'].map(steer => ({ dataset: { steer }, disabled: false, onclick: async () => {} }));
  const doc = { querySelector: (id: string) => elements[id], querySelectorAll: () => buttons } as unknown as Document;
  let approve = true, sends = 0, confirmations = 0, offline = false;
  const panel = mountSteerPanel(doc, (path, options) => {
    if (offline) return Promise.reject(Error('offline'));
    if (options?.method === 'POST') sends++;
    return fetch(base + path, { ...options, headers: { ...options?.headers, origin: base } });
  }, message => { confirmations++; expect(message).toContain('No changes are applied'); return approve; });
  await panel.open({ id: 'job:RQ-1', kind: 'job', lane: 'codex', details: {} });
  expect(elements['#steer-pending'].textContent).toBe('No pending proposals.');
  for (const [key, value] of Object.entries({ lane: 'devin', slots: '0', author: 'Mason', reason: '<script>rebalance</script>' })) elements['#steer-' + key].value = value;
  approve = false;
  const cancelled = buttons[0]!.onclick(); await buttons[0]!.onclick(); await cancelled;
  expect(sends).toBe(0); expect(confirmations).toBe(1);
  approve = true;
  for (const button of buttons) { await button.onclick(); expect(elements['#steer-status'].textContent).toContain('awaiting review'); }
  const before = readFileSync(journal, 'utf8'), records = before.trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ action: 'reassign', job_id: 'RQ-1', lane: 'devin', status: 'proposed' });
  expect(records[1]).toMatchObject({ action: 'set-slots', slots: 0, author: 'Mason', status: 'proposed' });
  expect(elements['#steer-pending'].textContent).toContain(records[0].id);
  expect(elements['#steer-pending'].textContent).toContain('<script>rebalance</script>');
  await buttons[0]!.onclick(); expect(elements['#steer-status'].textContent).toContain('duplicate proposal');
  expect(readFileSync(journal, 'utf8')).toBe(before);
  expect(readFileSync(slots, 'utf8')).toBe('{"codex":2}\n');
  expect(existsSync(join(root, 'fleet/actions.jsonl'))).toBe(false);
  writeFileSync(journal, records.map(p => JSON.stringify({ ...p, status: 'rejected' })).join('\n') + '\nbroken\n');
  await panel.open({ id: 'lane:codex', kind: 'lane', lane: 'codex', details: {} });
  expect(buttons[0]!.disabled).toBe(true); expect(buttons[1]!.disabled).toBe(false);
  expect(elements['#steer-pending'].textContent).toBe('1 unreadable journal records.\nNo pending proposals.');
  offline = true;
  await elements['#steer-refresh'].onclick();
  expect(elements['#steer-pending'].textContent).toContain('unavailable');
  await buttons[1]!.onclick(); expect(elements['#steer-status'].textContent).toContain('offline');
  expect(buttons[1]!.disabled).toBe(false);
  expect((await fetch(base + '/steer-panel.js')).headers.get('content-type')).toContain('javascript');
  expect(await (await fetch(base + '/node-map.js')).text()).toContain('steering.open(node)');
  expect(await (await fetch(base)).text()).toContain('data-steer="reassign"');
});

test('steer rejects bad host, origin, cross-site requests and malformed proposals without writing', async () => {
  const { base, journal, post } = fixture();
  for (const headers of [{ host: 'evil.example' }, { origin: '' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    expect((await post(proposal, headers)).status).toBe(403);
  }
  expect((await fetch(base + '/api/steer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proposal) })).status).toBe(403);
  expect((await fetch(base + '/api/steer', { headers: { host: 'evil.example' } })).status).toBe(403);
  expect((await fetch(base + '/api/steer', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
  for (const change of [{ confirmed: false }, { action: 'pause' }, { lane: '../bad' }, { slots: -1 }, { slots: 1025 }, { slots: 1.5 }, { slots: '' }, { author: '' }, { reason: '' }, { root: '/tmp' }, { output: 'slots.json' }, { job_id: 'RQ-1' }]) expect((await post({ ...proposal, ...change })).status).toBe(400);
  expect(existsSync(journal)).toBe(false);
  expect((await post(proposal)).status).toBe(202);
  expect((await post({ ...proposal, author: 'another', reason: 'different' })).status).toBe(409);
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toHaveLength(1);
});
