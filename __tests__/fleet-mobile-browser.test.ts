import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountMobileBrowser } from '../scripts/fleet-ui/mobile-browser.js';
import { mountMobile } from '../scripts/fleet-ui/mobile.js';
import { startFleetUi } from '../scripts/fleet-ui-server';
class Element {
  textContent = ''; hidden = true; children: Element[] = []; open = false; href?: string;
  onclick?: () => unknown; onclose?: () => void;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  showModal() { this.open = true; } close() { this.open = false; this.onclose?.(); }
  removeAttribute(name: string) { (this as Record<string, unknown>)[name] = undefined; }
}
function fixture(view?: EventTarget) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: get, createElement: () => new Element(), defaultView: view });
  return { doc, get };
}
function server() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-browser-')));
  mkdirSync(join(root, 'fleet'));
  for (const [file, data] of Object.entries({ 'targets.json': '{}', 'holds.json': '{}',
    'jobs.jsonl': '{"job_id":"RQ-1","pool":"codex","state":"running"}\n', 'leader-events.jsonl': '' }))
    writeFileSync(join(root, 'fleet', file), data);
  const dir = join(root, 'fleet', 'browser', 'RQ-1');
  mkdirSync(join(dir, 'frames'), { recursive: true });
  for (const n of [1, 2]) writeFileSync(join(dir, `frames/${n}.png`), 'png');
  writeFileSync(join(dir, 'frames.jsonl'), [1, 2].map(n => `{"path":"frames/${n}.png"}\n`).join(''));
  writeFileSync(join(dir, 'current-url.txt'), 'https://app.devin.ai/sessions/rq-1\n');
  const instance = startFleetUi({ root, port: 0 }), base = `http://127.0.0.1:${instance.port}`;
  return { root, dir, base, stop: async () => { await instance.stop(true); rmSync(root, { recursive: true, force: true }); } };
}
test('polls with the opaque cursor, renders latest frame and URL, and re-syncs after a rewrite', async () => {
  const { dir, base, stop } = server(), { doc, get } = fixture(), paths: string[] = [];
  const browser = mountMobileBrowser(doc as unknown as Document, { fetcher: (path, init) => { paths.push(path); return fetch(base + path, init); } });
  try {
    browser.open('RQ-1'); await browser.poll();
    expect(paths).toEqual(['/api/browser?job=RQ-1&limit=200']);
    expect(get('detail-browser').hidden).toBe(false);
    expect(get('browser-status').textContent).toBe('Live');
    expect(get('browser-url').textContent).toBe('Current URL: https://app.devin.ai/sessions/rq-1');
    expect(get('browser-url').href).toBe('https://app.devin.ai/sessions/rq-1');
    expect(get('browser-frame').hidden).toBe(false);
    expect(get('browser-frame').textContent).toBe('Latest frame: ' + join(dir, 'frames/2.png'));
    writeFileSync(join(dir, 'frames/3.png'), 'png');
    appendFileSync(join(dir, 'frames.jsonl'), '{"path":"frames/3.png"}\n');
    await browser.poll();
    expect(paths.at(-1)).toContain('job=RQ-1'); expect(paths.at(-1)).toContain('cursor=');
    expect(get('browser-frame').textContent).toBe('Latest frame: ' + join(dir, 'frames/3.png'));
    // Rewriting the frame index invalidates the cursor; the next poll restarts fresh.
    writeFileSync(join(dir, 'frames.jsonl'), '{"path":"frames/1.png"}\n');
    await browser.poll(); expect(get('browser-status').textContent).toContain('unavailable');
    await browser.poll(); expect(paths.at(-1)).not.toContain('cursor=');
    expect(get('browser-status').textContent).toBe('Live');
    expect(get('browser-frame').textContent).toBe('Latest frame: ' + join(dir, 'frames/1.png'));
    browser.close();
    expect(get('detail-browser').hidden).toBe(true);
    expect(get('browser-url').hidden).toBe(true); expect(get('browser-frame').hidden).toBe(true);
  } finally { browser.close(); await stop(); }
});
test('404, empty artifacts and non-job nodes show a clear empty state while polling continues', async () => {
  const { doc, get } = fixture(), paths: string[] = [];
  const page = { frames: [], cursor: 'opaque', has_more: false, latest_frame_path: null, current_url: null };
  const browser = mountMobileBrowser(doc as unknown as Document, {
    fetcher: async path => {
      paths.push(path);
      return paths.length === 1 ? new Response('', { status: 404 }) : Response.json(page);
    } });
  browser.open('RQ-2'); await browser.poll();
  expect(get('detail-browser').hidden).toBe(false);
  expect(get('browser-status').textContent).toBe('No live browser view for this job.');
  expect(get('browser-url').hidden).toBe(true); expect(get('browser-frame').hidden).toBe(true);
  await browser.poll();
  expect(paths).toHaveLength(2); expect(get('browser-status').textContent).toBe('No browser frames yet.');
  browser.open('lane:codex'); await browser.poll();
  expect(get('browser-status').textContent).toBe('No live browser view for this job.');
  expect(paths).toHaveLength(2);
  browser.close();
});
test('hidden polls are skipped and pause aborts in-flight work without losing the cursor', async () => {
  const { doc, get } = fixture();
  const pending: { path: string; signal?: AbortSignal; resolve: (response: Response) => void }[] = [];
  const page = (frame: string, cursor: string) => Response.json({ frames: [{ index: 0, path: frame }], cursor, has_more: false, latest_frame_path: frame, current_url: 'https://example.test/' });
  const browser = mountMobileBrowser(doc as unknown as Document, {
    fetcher: (path, init) => new Promise<Response>(resolve => pending.push({ path, signal: init?.signal ?? undefined, resolve })) });
  browser.open('RQ-1');
  const first = browser.poll(); expect(pending).toHaveLength(1); expect(pending[0].path).not.toContain('cursor=');
  pending[0].resolve(page('/f/1.png', 'c1')); await first;
  expect(get('browser-status').textContent).toBe('Live');
  const held = browser.poll(); expect(pending).toHaveLength(2);
  browser.pause(); expect(pending[1].signal?.aborted).toBe(true);
  pending[1].resolve(page('/f/stale.png', 'stale')); await held;
  expect(get('browser-frame').textContent).toBe('Latest frame: /f/1.png');
  doc.hidden = true; await browser.poll(); expect(pending).toHaveLength(2);
  doc.hidden = false;
  const resumed = browser.poll();
  expect(pending).toHaveLength(3); expect(pending[2].path).toContain('cursor=c1');
  pending[2].resolve(page('/f/2.png', 'c2')); await resumed;
  expect(get('browser-frame').textContent).toBe('Latest frame: /f/2.png');
  browser.close();
});
test('reported URLs render as text unless they are plain http(s) links', async () => {
  const { doc, get } = fixture();
  const browser = mountMobileBrowser(doc as unknown as Document, {
    fetcher: async () => Response.json({ frames: [], cursor: 'c', has_more: false, latest_frame_path: null, current_url: 'javascript:alert(1)' }) });
  browser.open('RQ-1'); await browser.poll();
  expect(get('browser-url').textContent).toBe('Current URL: javascript:alert(1)');
  expect(get('browser-url').href).toBeUndefined();
  browser.close();
});
test('session sheet mounts the embedded view; the worker shell stays servable', async () => {
  const { base, dir, stop } = server();
  const view = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const { doc, get } = fixture(view);
  const mobile = mountMobile(doc as unknown as Document, {
    fetcher: (path, init) => fetch(base + path, init),
    schedule: (() => 0) as unknown as typeof setTimeout });
  try {
    await mobile.ready;
    await get('running-list').children[0].children[0].onclick!();
    expect(get('detail').open).toBe(true);
    expect(get('browser-status').textContent).toBe('Live');
    expect(get('browser-frame').textContent).toBe('Latest frame: ' + join(dir, 'frames/2.png'));
    expect(get('browser-url').href).toBe('https://app.devin.ai/sessions/rq-1');
    get('close').onclick!();
    expect(get('detail-browser').hidden).toBe(true);
    // The canonical module ships embedded in a served asset; no route is needed.
    const served = await (await fetch(base + '/mobile-session.js')).text();
    const source = readFileSync(join(import.meta.dir, '../scripts/fleet-ui/mobile-browser.js'), 'utf8');
    expect(served.split('// BEGIN generated mobile-browser.js (static route allowlist; sync checked in tests)\n')[1]
      .split('// END generated mobile-browser.js')[0]).toBe(source.replace('export function ', 'function '));
    expect(served).not.toContain("from './mobile-browser.js'");
    const html = await (await fetch(base + '/mobile')).text();
    expect(html).toContain('id="detail-browser"'); expect(html).toContain('id="browser-frame"');
    // Every precached shell path must resolve on the live server or install fails.
    const sw = readFileSync(join(import.meta.dir, '../scripts/fleet-ui/mobile-sw.js'), 'utf8');
    const shell = [...sw.matchAll(/'([^']+)'/g)].map(match => match[1]).filter(path => path.startsWith('/'));
    expect(shell).not.toContain('/mobile-browser.js');
    for (const path of shell) expect((await fetch(base + path)).status).toBe(200);
  } finally { mobile.stop(); await stop(); }
});
