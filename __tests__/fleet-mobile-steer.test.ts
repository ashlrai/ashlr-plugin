import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountMobileSteer } from '../scripts/fleet-ui/mobile-steer.js';
import { mountMobile } from '../scripts/fleet-ui/mobile.js';
import { startFleetUi } from '../scripts/fleet-ui-server';

test('mobile steering confirms both proposals, refuses requests, and ships through the unchanged server', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-steer-')));
  mkdirSync(join(root, 'fleet'));
  for (const [file, data] of Object.entries({ 'targets.json': '{"codex":2}', 'holds.json': '{}', 'jobs.jsonl': '{"job_id":"RQ-1","pool":"codex"}\n', 'leader-events.jsonl': '', 'slots.json': '{"codex":2}' })) writeFileSync(join(root, 'fleet', file), data);
  const server = startFleetUi({ root, port: 0 }), base = `http://127.0.0.1:${server.port}`, journal = join(root, 'fleet/steer-proposals.jsonl');
  class Element { value = ''; textContent = ''; innerHTML = ''; inert = false; disabled = false; hidden = false; open = false; onclick = async () => {}; append() {} replaceChildren() {} }
  const elements = new Map<string, Element>(), get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const el = (id: string) => get('mobile-steer-' + id), view = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const doc = Object.assign(new EventTarget(), { getElementById: get, createElement: () => new Element(), defaultView: view, querySelectorAll: () => ['reassign', 'set-slots'].map(el) }) as unknown as Document;
  let approve = true, forbidden = false, unavailable = false, sends = 0, confirmations = 0, duringConfirm = () => {};
  const panel = mountMobileSteer(doc, {
    fetcher: (path, init) => {
      if (unavailable) return Promise.reject(Error('unavailable'));
      if (init?.method === 'POST') sends++;
      return fetch(base + path, { ...init, headers: { ...init?.headers, origin: forbidden ? 'https://evil.example' : base } });
    },
    confirm: message => { confirmations++; expect(message).toContain('No changes are applied'); expect(message).toContain('"lane": "devin"'); duringConfirm(); return approve; },
  });
  const mobile = mountMobile(doc, { fetcher: (path, init) => fetch(base + path, init), schedule: (() => 0) as unknown as typeof setTimeout });
  try {
    await mobile.ready;
    await panel.ready; expect(el('lanes').textContent).toContain('codex'); expect(el('pending').textContent).toBe('No pending proposals.');
    for (const [id, value] of Object.entries({ lane: 'devin', job: 'RQ-1', slots: '0', author: 'Mason', reason: '<script>rebalance</script>' })) el(id).value = value;
    approve = false; await el('reassign').onclick(); expect(sends).toBe(0); expect(el('status').textContent).toBe('Proposal cancelled.');
    approve = true;
    const first = el('reassign').onclick(); await el('reassign').onclick(); await first;
    await el('set-slots').onclick(); expect(sends).toBe(2); expect(confirmations).toBe(3);
    const before = readFileSync(journal, 'utf8'), records = before.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(2); expect(records[0]).toMatchObject({ action: 'reassign', job_id: 'RQ-1', lane: 'devin', status: 'proposed' });
    expect(records[1]).toMatchObject({ action: 'set-slots', slots: 0, author: 'Mason', reason: '<script>rebalance</script>', status: 'proposed' });
    expect(el('status').textContent).toContain('awaiting review'); expect(el('pending').textContent).toContain(records[0].id);
    await el('reassign').onclick(); expect(el('status').textContent).toContain('duplicate proposal');
    forbidden = true; await el('set-slots').onclick(); expect(el('status').textContent).toContain('refused · forbidden'); forbidden = false;
    expect(readFileSync(journal, 'utf8')).toBe(before); expect(readFileSync(join(root, 'fleet/slots.json'), 'utf8')).toBe('{"codex":2}'); expect(existsSync(join(root, 'fleet/actions.jsonl'))).toBe(false);
    const sent = sends;
    for (const slots of ['', '-1', '1.5', '1025']) { el('slots').value = slots; await el('set-slots').onclick(); expect(el('status').textContent).toContain('Check lane'); }
    duringConfirm = () => { view.navigator.onLine = false; view.dispatchEvent(new Event('offline')); };
    await el('reassign').onclick(); expect(el('status').textContent).toContain('Offline'); expect(sends).toBe(sent);
    view.navigator.onLine = true; get('remote').inert = true; await el('reassign').onclick(); expect(sends).toBe(sent);
    get('remote').inert = false; duringConfirm = () => {};
    await mobile.poll(); expect(el('reassign').disabled).toBe(false); expect(el('set-slots').disabled).toBe(false);
    await el('reassign').onclick(); expect(el('status').textContent).toContain('duplicate proposal');
    writeFileSync(journal, records.map(p => JSON.stringify({ ...p, status: 'rejected' })).join('\n'));
    await panel.refresh(); expect(el('pending').textContent).toBe('No pending proposals.');
    unavailable = true; await panel.refresh(); expect(el('pending').textContent).toContain('unavailable'); unavailable = false;
    await panel.refresh(); expect(el('lanes').textContent).toContain('codex');
    const html = await (await fetch(base + '/mobile')).text(), source = readFileSync(join(import.meta.dir, '../scripts/fleet-ui/mobile-steer.js'), 'utf8');
    expect(html.split('<script type="module" id="mobile-steer-module">\n')[1].split('</script>')[0]).toBe(source);
    expect(source).toContain("if (typeof document !== 'undefined') mountMobileSteer(document)");
  } finally { mobile.stop(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
