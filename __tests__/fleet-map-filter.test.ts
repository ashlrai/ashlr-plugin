import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createMapFilter } from '../scripts/fleet-ui/map-filter.js';
import { mountNodeMap } from '../scripts/fleet-ui/node-map.js';

const job = (state = 'running') => ({ id: 'job:RQ-42', kind: 'job', lane: 'codex', details: {
  job_id: 'RQ-42', repo: 'ashlrai/plugin', state, pr_url: 'https://github.com/ashlrai/plugin/pull/812',
} });
const pr = { id: 'pr:RQ-42', kind: 'pr', lane: 'codex', details: { job_id: 'RQ-42', url: job().details.pr_url } };

test('filter matches job, lane, repository and PR case-insensitively; dims only nonmatches', () => {
  const filter = createMapFilter(); filter.apply([job(), pr], 0);
  for (const node of [job(), pr]) {
    for (const query of ['', '  ', ' rq-42 ', 'CODEX', 'AshlrAI/Plugin', '812', '#812']) expect(filter.alpha(node, query)).toBe(1);
    for (const query of ['missing', '.*', '<script>', 'running']) expect(filter.alpha(node, query)).toBe(.15);
  }
  expect(filter.alpha({ id: 'leader', kind: 'leader', details: {} }, '812')).toBe(.15);
  expect(filter.alpha({ ...job(), details: { pr_number: 91 } }, '#91')).toBe(1);
  expect(filter.alpha({ ...job(), details: { prUrl: 'https://example.test/pr/12?tab=files' } }, '#12')).toBe(1);
});

test('pulse diff establishes a baseline, ignores key order, expires and drops removed nodes', () => {
  const filter = createMapFilter(); filter.apply([job(), pr], 0);
  expect(filter.pulse(job().id, 0)).toBe(0);
  filter.apply([pr, { ...job(), details: { ...Object.fromEntries(Object.entries(job().details).reverse()) } }], 10);
  expect(filter.pulse(job().id, 10)).toBe(0);
  filter.apply([job('failed'), pr], 20);
  expect(filter.pulse(job().id, 20)).toBe(1);
  expect(filter.pulse(pr.id, 20)).toBe(1);
  filter.apply([job('failed'), pr], 520);
  expect(filter.pulse(job().id, 520)).toBe(.5);
  expect(filter.pulse(job().id, 1020)).toBe(0);
  filter.apply([], 530);
  expect(filter.pulse(job().id, 530)).toBe(0);
  filter.apply([job()], 540);
  expect(filter.pulse(job().id, 540)).toBe(1);
});

test('served renderer embeds the exact canonical helper without an unserved module import', () => {
  const source = readFileSync(new URL('../scripts/fleet-ui/node-map.js', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('../scripts/fleet-ui/map-filter.js', import.meta.url), 'utf8').replace('export function', 'function');
  expect(source.split('// BEGIN map-filter.js')[1]!.split('\n').slice(1).join('\n').split('// END map-filter.js')[0]).toBe(helper);
  expect(source).not.toMatch(/import.*['"]\.\/map-filter\.js['"]/);
});

test.each([false, true])('canvas colors, dimming, pulses and poll recovery (reduced motion: %s)', async reducedMotion => {
  const media = globalThis.matchMedia;
  globalThis.matchMedia = (() => ({ matches: reducedMotion })) as unknown as typeof matchMedia;
  const made: any[] = [], elements = new Map<string, any>(), fills: any[] = [], strokes: any[] = [], edges: number[] = [];
  const element = () => ({ value: '', children: [] as any[], append(...items: any[]) { this.children.push(...items); }, replaceChildren(...items: any[]) { this.children = items; } });
  const ctx: any = { globalAlpha: 1, setTransform() {}, clearRect() { fills.length = strokes.length = edges.length = 0; }, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fillText() {},
    fill() { fills.push([this.fillStyle, this.globalAlpha]); }, stroke() { strokes.push(this.strokeStyle); if (this.strokeStyle === '#52627d') edges.push(this.globalAlpha); } };
  const canvas = { ...element(), clientWidth: 800, clientHeight: 600, getContext: () => ctx };
  const doc = { querySelector(key: string) { if (key === 'canvas') return canvas; if (!elements.has(key)) elements.set(key, element()); return elements.get(key); },
    createElement(tag: string) { const item = { ...element(), tag }; made.push(item); return item; } };
  let state = 'running', time = 0, offline = false;
  const view = mountNodeMap(doc as unknown as Document, { frame: () => 0, now: () => time,
    schedule: (() => 0) as unknown as typeof setTimeout, cancel: (() => {}) as unknown as typeof clearTimeout,
    fetcher: async path => { if (offline) throw Error('offline'); return new Response(JSON.stringify(path === '/api/graph' ? { nodes: [job(state)] } : {})); },
  });
  try {
    await view.ready; view.draw(); expect(fills).toContainEqual(['#60a5fa', 1]);
    expect(strokes).not.toContain('#60a5fa');
    const input = made.find(item => item.tag === 'input'); input.value = 'missing'; input.oninput();
    view.draw(); expect(fills.every(([, alpha]) => alpha === .15)).toBe(true); expect(edges.every(alpha => alpha < .15)).toBe(true);
    expect(made.find(item => item.tag === 'output').textContent).toBe(' 0/7 matching');
    input.value = 'plugin'; input.oninput(); view.draw(); expect(fills).toContainEqual(['#60a5fa', 1]);
    for (const [next, color] of [['failed', '#f87171'], ['merged', '#34d399'], ['empty', '#94a3b8'], ['done', '#fbbf24']]) {
      state = next!; time += 1500; await view.poll(); view.draw(); expect(fills).toContainEqual([color, 1]); expect(strokes.includes(color)).toBe(!reducedMotion);
    }
    offline = true; await view.poll(); expect(elements.get('#status').textContent).toContain('Disconnected');
    offline = false; state = 'running'; time += 1500; await view.poll(); view.draw(); expect(strokes.includes('#60a5fa')).toBe(!reducedMotion);
    time += 1000; view.draw(); expect(strokes).not.toContain('#60a5fa'); expect(ctx.globalAlpha).toBe(1);
  } finally { view.stop(); if (media) globalThis.matchMedia = media; else Reflect.deleteProperty(globalThis, 'matchMedia'); }
});
