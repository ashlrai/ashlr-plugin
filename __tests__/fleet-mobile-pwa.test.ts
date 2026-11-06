import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { mountMobile } from '../scripts/fleet-ui/mobile.js';
import { mountMobileActions } from '../scripts/fleet-ui/mobile-actions.js';
import { startFleetUi } from '../scripts/fleet-ui-server';
const asset = (name: string) => readFileSync(join(import.meta.dir, '../scripts/fleet-ui', name), 'utf8');
test('worker caches only the shell; API, logs, state and non-GET requests bypass every cache operation', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  let reads = 0, network = 0, added: string[] = [], deleted: string[] = [];
  const cached = new Response('shell');
  runInNewContext(asset('mobile-sw.js'), { URL, self: { location: { origin: 'https://fleet.test' }, addEventListener: (name: string, fn: any) => handlers[name] = fn },
    caches: { open: async () => { reads++; return { addAll: async (urls: string[]) => { added = urls; }, match: async () => cached }; },
      keys: async () => ['ashlr-mobile-shell-v0', 'unrelated'], delete: async (key: string) => deleted.push(key) },
    fetch: async () => { network++; return new Response('network'); } });
  let pending!: Promise<unknown>;
  handlers.install({ waitUntil: (p: Promise<unknown>) => pending = p }); await pending;
  expect(added).toContain('/mobile'); expect(added.some(url => /api|logs|state/.test(url))).toBe(false);
  handlers.activate({ waitUntil: (p: Promise<unknown>) => pending = p }); await pending;
  expect(deleted).toEqual(['ashlr-mobile-shell-v0']); reads = 0;
  for (const path of ['/api', '/api/graph', '/api/actions', '/api/log-tail?job=RQ-1', '/api/session', '/api/browser', '/logs', '/state', '/mobile?state=secret', 'https://other.test/mobile']) {
    for (const method of ['GET', 'POST']) handlers.fetch({ request: new Request(new URL(path, 'https://fleet.test'), { method }), respondWith() { throw Error('must use network directly'); } });
  }
  expect(reads).toBe(0); expect(network).toBe(0);
  handlers.fetch({ request: new Request('https://fleet.test/mobile'), respondWith: (p: Promise<Response>) => pending = p });
  expect(await pending).toBe(cached); expect(reads).toBe(1);
});
class Element {
  textContent = ''; hidden = true; children: Element[] = []; disabled = false; inert = false; open = false; value = 'maintenance';
  onclick?: () => unknown; onclose?: () => void;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  close() { this.open = false; this.onclose?.(); }
}
test('offline boot and disconnect disable all actions, block sends after confirmation, and recover only after fresh state', async () => {
  const elements = new Map<string, Element>(), controls: Element[] = [], view = new EventTarget() as EventTarget & { navigator: { onLine: boolean } };
  view.navigator = { onLine: false };
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = { defaultView: view, getElementById: get, querySelectorAll: () => controls, createElement: (tag: string) => { const el = new Element(); if (tag === 'button') controls.push(el); return el; }, addEventListener() {}, removeEventListener() {} } as unknown as Document;
  controls.push(get('refresh'), get('remote-reason'));
  let finishSend: (() => void) | undefined, deferSend = false;
  let sends = 0, polls = 0, confirm!: (value: boolean) => void;
  const actions = mountMobileActions(doc, { send: async () => { sends++; if (deferSend) await new Promise<void>(resolve => finishSend = resolve); return { status: 'pending', id: '1' }; }, confirm: () => new Promise<boolean>(resolve => confirm = resolve) });
  const mobile = mountMobile(doc, { fetcher: async () => { polls++; return Response.json({ nodes: [{ id: 'lane:x', kind: 'lane', lane: 'x', details: {} }], errors: {} }); }, onSnapshot: snapshot => actions.update(snapshot as Parameters<typeof actions.update>[0]), schedule: (() => 0) as unknown as typeof setTimeout });
  await mobile.ready; expect(polls).toBe(0); expect(get('stale').textContent).toContain('Offline'); expect(controls.every(el => el.disabled)).toBe(true);
  view.navigator.onLine = true; await mobile.poll(); expect(controls.every(el => !el.disabled)).toBe(true);
  const kill = actions.run('kill', { job_id: 'RQ-1' }, 'maintenance');
  view.navigator.onLine = false; view.dispatchEvent(new Event('offline')); confirm(true); await kill;
  await actions.run('pause', { lane: 'x' }, 'maintenance');
  for (const button of controls) await button.onclick?.();
  expect(sends).toBe(0); expect(controls.every(el => el.disabled)).toBe(true); expect(get('mobile-content').inert).toBe(true);
  view.navigator.onLine = true; await actions.run('resume', { lane: 'x' }, 'maintenance'); expect(sends).toBe(0);
  await mobile.poll(); await actions.run('resume', { lane: 'x' }, 'maintenance'); expect(sends).toBe(1); expect(get('stale').hidden).toBe(true);
  deferSend = true; const sending = get('remote-lanes').children[0].children[0].onclick!();
  view.navigator.onLine = false; view.dispatchEvent(new Event('offline')); finishSend!(); await sending;
  expect(controls.every(el => el.disabled)).toBe(true); mobile.stop();
});
test('live server serves the install manifest, icons, worker and complete shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-pwa-')), server = startFleetUi({ root, port: 0 }), base = `http://127.0.0.1:${server.port}`;
  try {
    const manifest = await fetch(base + '/mobile.webmanifest'); expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    const data = await manifest.json(); expect(data.display).toBe('standalone'); expect(data.start_url).toBe('/mobile');
    for (const path of ['/mobile', '/mobile.js', '/mobile-actions.js', '/mobile-session.js', '/session-panel.js', ...data.icons.map((icon: any) => icon.src)]) expect((await fetch(base + path)).status).toBe(200);
    const worker = await fetch(base + '/mobile-sw.js'); expect(worker.headers.get('content-type')).toContain('javascript'); expect(await worker.text()).toBe(asset('mobile-sw.js'));
    expect(asset('mobile.html')).toContain('rel="manifest"'); expect(asset('mobile.html')).toContain("serviceWorker.register('/mobile-sw.js'");
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
