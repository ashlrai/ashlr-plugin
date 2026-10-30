import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountMobileAlerts } from '../scripts/fleet-ui/mobile-alerts.js';
import { mountMobile } from '../scripts/fleet-ui/mobile.js';
import { startFleetUi } from '../scripts/fleet-ui-server';
const ts = '2026-10-30T12:00:00Z', now = Date.parse(ts);
const job = { id: 'job:RQ-1', kind: 'job', lane: 'codex', details: { job_id: 'RQ-1', state: 'stalled', updated_at: ts } };
const graph = () => ({ nodes: [structuredClone(job)], errors: {}, leader_event: { ts, main: { status: 'red', job_id: 'RQ-1' }, lanes: { codex: { launches_30m: 0, job_id: 'RQ-1' } } } });
class Element {
  textContent = ''; hidden = true; children: Element[] = []; open = false; inert = false;
  onclick?: () => unknown; onclose?: () => void;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  showModal() { this.open = true; } close() { this.open = false; this.onclose?.(); }
}
function fixture() {
  const elements = new Map<string, Element>(), view = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = Object.assign(new EventTarget(), { hidden: false, defaultView: view, getElementById: get, createElement: () => new Element() }) as unknown as Document;
  return { doc, get, view };
}
for (const [index, label] of ['Main is red', 'codex: 0 launches in 30 min', 'RQ-1 stalled'].entries()) test(label + ' opens its session', () => {
  const { doc, get } = fixture(), opened: unknown[] = [], alerts = mountMobileAlerts(doc, node => opened.push(node), () => now);
  alerts.update(graph()); expect(get('alert-count').textContent).toBe('3'); expect(get('mobile-alerts').hidden).toBe(false);
  const link = get('alert-list').children[index].children[0]; expect(link.textContent).toContain(label); link.onclick!(); expect(opened).toEqual([job]);
});
test('stale, partial, missing, malformed, future and healthy observations do not alert', () => {
  const { doc, get } = fixture(), alerts = mountMobileAlerts(doc, () => {}, () => now);
  for (const data of [null, { ...graph(), stale: true }, { ...graph(), errors: { jobs: 'missing' } },
    ...['2026-10-30T11:54:59Z', '2026-10-30T12:00:01Z', '', 'invalid'].map(old => ({ ...graph(), leader_event: { ...graph().leader_event, ts: old }, nodes: [{ ...job, details: { ...job.details, updated_at: old } }] })),
    { nodes: [job], leader_event: null, errors: { network: true } }, { nodes: [], errors: {} },
    { ...graph(), nodes: [{ ...job, details: { ...job.details, state: 'running' } }], leader_event: { ts, main: { status: 'green' }, lanes: { codex: { launches_30m: 1 } } } }]) {
    alerts.update(graph()); alerts.update(data); expect(get('mobile-alerts').hidden).toBe(true); expect(get('alert-count').textContent).toBe('0');
  }
});
test('dismiss persists across polls and outages, then re-arms only after observed recovery', () => {
  const { doc, get } = fixture(), alerts = mountMobileAlerts(doc, () => {}, () => now);
  alerts.update(graph()); for (const li of [...get('alert-list').children]) li.children[1].onclick!();
  alerts.clear(); alerts.update({ ...graph(), stale: true }); alerts.update({ ...graph(), errors: { jobs: 'missing' } }); alerts.update(graph()); expect(get('mobile-alerts').hidden).toBe(true);
  const healthy = graph(); healthy.leader_event.main.status = 'green'; healthy.leader_event.lanes.codex.launches_30m = 1; healthy.nodes[0].details.state = 'done';
  alerts.update(healthy); alerts.update(graph()); expect(get('alert-count').textContent).toBe('3');
});
test('mobile wiring opens sessions and clears alerts on errors, hidden, offline and stop', async () => {
  const { doc, get, view } = fixture(); let fail = false;
  const mobile = mountMobile(doc, { now: () => new Date(now), schedule: (() => 0) as unknown as typeof setTimeout,
    fetcher: async path => { if (fail) throw Error('offline'); return Response.json(path.startsWith('/api/log-tail') ? { lines: [], errors: {} } : graph()); } });
  await mobile.ready; await get('alert-list').children[0].children[0].onclick!(); expect(get('detail').open).toBe(true);
  fail = true; await mobile.poll(); expect(get('mobile-alerts').hidden).toBe(true); fail = false; await mobile.poll();
  Object.defineProperty(doc, 'hidden', { value: true, writable: true }); doc.dispatchEvent(new Event('visibilitychange')); expect(get('mobile-alerts').hidden).toBe(true);
  Object.defineProperty(doc, 'hidden', { value: false }); await mobile.poll(); view.navigator.onLine = false; view.dispatchEvent(new Event('offline')); expect(get('mobile-alerts').hidden).toBe(true);
  view.navigator.onLine = true; await mobile.poll(); expect(get('alert-count').textContent).toBe('3'); mobile.stop(); expect(get('mobile-alerts').hidden).toBe(true);
});
test('freshness boundary blocks expired session taps; lane evidence must reference its own job', () => {
  const { doc, get } = fixture(); let time = now + 300000, opened = 0;
  const alerts = mountMobileAlerts(doc, () => opened++, () => time); alerts.update(graph()); expect(get('alert-count').textContent).toBe('3');
  const link = get('alert-list').children[0].children[0]; time++; link.onclick!(); expect(opened).toBe(0); alerts.update(graph()); expect(get('mobile-alerts').hidden).toBe(true);
  time = now; const wrong = graph(); wrong.nodes[0].lane = 'other'; wrong.nodes[0].details.state = 'running'; wrong.leader_event.main.status = 'green';
  alerts.update(wrong); expect(get('mobile-alerts').hidden).toBe(true);
});
test('served mobile embeds the canonical module exactly without requiring a new asset route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-alerts-')), server = startFleetUi({ root, port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/mobile.js`); expect(response.status).toBe(200);
    const served = await response.text(), source = readFileSync(join(import.meta.dir, '../scripts/fleet-ui/mobile-alerts.js'), 'utf8');
    expect(served.split('// BEGIN generated mobile-alerts.js (static route allowlist; sync checked in tests)\n')[1].split('// END generated mobile-alerts.js')[0]).toBe(source.replace('export function ', 'function '));
    expect(served).not.toContain("from './mobile-alerts.js'");
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
