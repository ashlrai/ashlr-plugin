import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFleetUi } from '../scripts/fleet-ui-server';
import { createNodeMap, layout, mountNodeMap, pick, project } from '../scripts/fleet-ui/node-map.js';
import { createSessionPanel } from '../scripts/fleet-ui/session-panel.js';

class Element {
  textContent = ''; children: Element[] = []; value = ''; open = false;
  onclick?: () => unknown; onchange?: () => unknown; onclose?: () => void;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.onclose?.(); }
}
class Canvas extends Element {
  clientWidth = 800; clientHeight = 600; width = 0; height = 0;
  texts: string[] = [];
  ctx = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '',
    setTransform: () => {}, clearRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => {}, arc: () => {}, fill: () => {}, fillText: (text: string) => { this.texts.push(text); },
  };
  getContext(_kind?: string) { return this.ctx; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  onpointerdown?: (event: any) => void; onpointermove?: (event: any) => void; onpointerup?: (event: any) => void;
  onpointercancel?: () => void; onwheel?: (event: any) => void;
}
function fixture() {
  const canvas = new Canvas(), elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = {
    querySelector: (selector: string) => selector === 'canvas' ? canvas : get(selector.slice(1)),
    getElementById: get, createElement: () => new Element(),
  } as unknown as Document;
  return { doc, canvas, get };
}

let root: string, server: ReturnType<typeof startFleetUi>, base: string;
const file = (name: string) => join(root, 'fleet', name);
const jobs = (rows: unknown[]) => writeFileSync(file('jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const options = { schedule: (() => 0) as unknown as typeof setTimeout, cancel: (() => {}) as unknown as typeof clearTimeout, frame: () => 0 };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'node-map-')));
  mkdirSync(join(root, 'fleet', 'logs'), { recursive: true });
  writeFileSync(file('targets.json'), JSON.stringify({ alpha: 2, beta: 1 }));
  writeFileSync(file('holds.json'), JSON.stringify({ beta: 'freeze' }));
  jobs([
    { job_id: 'J-1', pool: 'alpha', state: 'running' },
    { job_id: 'J-2', pool: 'alpha', state: 'done', pr_url: 'https://example.test/pr/2' },
    { job_id: 'J-3', pool: 'beta', state: 'queued' },
  ]);
  writeFileSync(file('leader-events.jsonl'), '{"event":"dispatch","job_id":"J-1"}\n');
  writeFileSync(join(root, 'fleet', 'logs', 'J-2.log'), 'boot\n');
  server = startFleetUi({ root, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => { await server.stop(true); rmSync(root, { recursive: true, force: true }); });

test('every leader, lane, job, PR and resource in the fixture graph becomes one node', async () => {
  const { doc, canvas, get } = fixture();
  const view = mountNodeMap(doc, { ...options, fetcher: async (path: string) => fetch(base + path) });
  await view.ready;
  const graph = view.map.graph();
  expect(graph.nodes.filter(node => node.kind === 'lane').map(node => node.id)).toEqual(['lane:alpha', 'lane:beta']);
  expect(graph.nodes.filter(node => node.kind === 'job').map(node => node.id)).toEqual(['job:J-1', 'job:J-2', 'job:J-3']);
  expect(graph.nodes.filter(node => node.kind === 'pr')).toEqual([{ id: 'pr:J-2', kind: 'pr', lane: 'alpha', details: { job_id: 'J-2', url: 'https://example.test/pr/2' } }]);
  expect(graph.nodes.filter(node => node.kind === 'resource').map(node => node.id))
    .toEqual(['resource:holds.json', 'resource:jobs.jsonl', 'resource:leader-events.jsonl', 'resource:targets.json']);
  expect(graph.nodes.find(node => node.kind === 'leader')).toMatchObject({ id: 'leader', details: { event: 'dispatch' } });
  for (const link of [{ source: 'leader', target: 'lane:alpha' }, { source: 'lane:alpha', target: 'job:J-2' }, { source: 'job:J-2', target: 'pr:J-2' }, { source: 'resource:jobs.jsonl', target: 'leader' }])
    expect(graph.links).toContainEqual(link);
  expect(get('status').textContent).toBe('Live · 11 nodes');
  expect(get('nodes').children.map(option => option.value)).toEqual(['', ...graph.nodes.map(node => node.id)]);
  expect((await fetch(base + '/node-map.js')).headers.get('content-type')).toContain('javascript');
  view.draw();
  expect(canvas.texts).toEqual(expect.arrayContaining(['leader', 'alpha', 'J-2', 'PR J-2', 'targets.json']));
  view.stop();
});

test('clicking a node selects it and opens the right session', async () => {
  const { doc, canvas } = fixture();
  const views: any[] = [], opened: string[] = [];
  const session = createSessionPanel(async (path: string) => (await fetch(base + path)).json(), (view: any) => views.push(view));
  const view = mountNodeMap(doc, {
    ...options, fetcher: async (path: string) => fetch(base + path),
    open(node) { opened.push(node.id); void session.open(node).catch(() => {}); },
  });
  try {
    await view.ready;
    view.draw();
    const target = view.points.find(point => point.node.id === 'job:J-2')!;
    canvas.onpointerdown!({ clientX: target.x, clientY: target.y, pointerId: 1 });
    canvas.onpointerup!({ clientX: target.x, clientY: target.y, pointerId: 1 });
    expect(view.selected).toBe('job:J-2');
    expect(opened).toEqual(['job:J-2']);
    expect(views.at(-1).node.id).toBe('job:J-2');
    for (let i = 0; i < 50 && !views.at(-1).lines.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(views.at(-1).lines).toEqual(['boot']);
    expect(views.at(-1).state).toBe('done');
    const other = view.points.find(point => point.node.id === 'job:J-1')!;
    canvas.onpointerdown!({ clientX: other.x, clientY: other.y, pointerId: 2 });
    canvas.onpointermove!({ clientX: other.x + 40, clientY: other.y + 30, pointerId: 2 });
    canvas.onpointerup!({ clientX: other.x + 40, clientY: other.y + 30, pointerId: 2 });
    expect(opened).toEqual(['job:J-2']);
    const selector = doc.querySelector('#nodes') as unknown as Element;
    selector.value = 'job:J-1'; selector.onchange!();
    expect(view.selected).toBe('job:J-1');
    expect(opened).toEqual(['job:J-2', 'job:J-1']);
    canvas.onpointerdown!({ clientX: 5, clientY: 5, pointerId: 3 });
    canvas.onpointerup!({ clientX: 5, clientY: 5, pointerId: 3 });
    expect(opened).toEqual(['job:J-2', 'job:J-1']);
  } finally { session.close(); view.stop(); }
});

test('whole graph pages add, update and drop nodes; errors surface on resources and clear', async () => {
  const { doc, get } = fixture();
  let offline = false;
  const view = mountNodeMap(doc, { ...options, fetcher: (path: string) => offline ? Promise.reject(Error('offline')) : fetch(base + path) });
  await view.ready;
  appendFileSync(file('jobs.jsonl'), JSON.stringify({ job_id: 'J-1', pool: 'alpha', state: 'done' }) + '\n' +
    JSON.stringify({ job_id: 'J-4', pool: 'beta', state: 'running', pr_url: 'https://example.test/pr/4' }) + '\n');
  await view.poll();
  let graph = view.map.graph();
  expect(graph.nodes.filter(node => node.kind === 'job').map(node => node.id)).toEqual(['job:J-1', 'job:J-2', 'job:J-3', 'job:J-4']);
  expect(graph.nodes.find(node => node.id === 'job:J-1')).toMatchObject({ details: { state: 'done' } });
  expect(graph.nodes.filter(node => node.kind === 'pr').map(node => node.id)).toEqual(['pr:J-2', 'pr:J-4']);
  jobs([{ job_id: 'J-1', pool: 'alpha', state: 'done' }, { job_id: 'J-2', pool: 'alpha', state: 'done', pr_url: 'https://example.test/pr/2' }]);
  await view.poll();
  graph = view.map.graph();
  expect(graph.nodes.filter(node => node.kind === 'job').map(node => node.id)).toEqual(['job:J-1', 'job:J-2']);
  expect(graph.nodes.filter(node => node.kind === 'pr').map(node => node.id)).toEqual(['pr:J-2']);
  rmSync(file('targets.json'));
  await view.poll();
  graph = view.map.graph();
  expect(graph.nodes.filter(node => node.kind === 'lane')).toHaveLength(2);
  expect(graph.nodes.find(node => node.id === 'resource:targets.json')).toMatchObject({ details: { status: 'missing' } });
  expect(get('status').textContent).toContain('unavailable');
  offline = true;
  await view.poll();
  expect(get('status').textContent).toContain('Disconnected');
  expect(view.map.graph().nodes.filter(node => node.kind === 'job')).toHaveLength(2);
  writeFileSync(file('targets.json'), JSON.stringify({ alpha: 2, beta: 1 }));
  offline = false;
  await view.poll();
  expect(get('status').textContent).toBe('Live · 10 nodes');
  expect(view.map.graph().nodes.filter(node => node.kind === 'lane')).toHaveLength(2);
  view.stop();
});

test('rejects malformed pages and picks the nearest front-most node in radius', () => {
  const map = createNodeMap();
  for (const page of [null, {}, { nodes: {} }, { nodes: [{ id: 7, kind: 'job', details: {} }] },
    { nodes: [{ id: 'j', kind: 'job' }] }, { nodes: [{ id: 'j', kind: 'job', lane: 5, details: {} }] },
    { nodes: [], errors: 'bad' }, { nodes: [], errors: { 'jobs.jsonl': 9 } }])
    expect(() => map.apply(page as any)).toThrow('Invalid graph');
  map.apply({
    nodes: [
      { id: 'lane:a', kind: 'lane', lane: 'a', details: { target: 1 } },
      { id: 'job:j', kind: 'job', lane: 'a', details: { job_id: 'j', pr_url: 'https://example.test/1' } },
    ],
    leader_event: { event: 'x' }, errors: {},
  });
  expect(map.leader).toEqual({ event: 'x' });
  const points = project(layout(map.graph().nodes), { angle: 0, tilt: 0, zoom: 1 }, 800, 600);
  const lane = points.find(point => point.node.id === 'lane:a')!;
  expect(pick(points, lane.x, lane.y)?.id).toBe('lane:a');
  expect(pick(points, 5, 5, 10)).toBeNull();
  const node = (id: string) => ({ id, kind: 'job', lane: '', details: {} });
  expect(pick([{ node: node('far'), x: 0, y: 0, depth: .9 }, { node: node('near'), x: 0, y: 0, depth: -.9 }], 0, 0)?.id).toBe('near');
});
