import { expect, test } from 'bun:test';
import { mountMobile } from '../scripts/fleet-ui/mobile.js';
class Element {
  textContent = ''; hidden = true; children: Element[] = []; type = ''; open = false;
  onclick?: () => unknown; onclose?: () => void;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.onclose?.(); }
}
function fixture() {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = { getElementById: get, createElement: () => new Element() } as unknown as Document;
  return { doc, get };
}
const job = (id: string, state: string, extra = {}) => ({ id, kind: 'job', lane: 'personal', details: { job_id: id, state, ...extra } });
const graph = { errors: {}, nodes: [
  { id: 'lane:personal', kind: 'lane', lane: 'personal', details: { target: 2, hold: 'maintenance' } },
  job('RQ-live', 'running', { title: '<img src=x onerror=alert(1)>' }),
  job('RQ-new', 'merged', { merged_at: '2026-10-30' }), job('RQ-old', 'merged', { merged_at: '2026-10-29' }), job('RQ-done', 'done'),
] };
test('polls state, renders lanes and merges, opens fresh job details, retains stale data and recovers', async () => {
  const { doc, get } = fixture(); let data: unknown = graph, ok = true, calls = 0, scheduled = 0;
  const mobile = mountMobile(doc, {
    fetcher: (async (path: string) => { expect(path).toBe('/api/graph'); calls++; return { ok, json: async () => data }; }) as typeof fetch,
    schedule: ((_fn: unknown, ms: number) => { expect(ms).toBe(5000); scheduled++; return 1; }) as unknown as typeof setTimeout,
    cancel: (() => {}) as typeof clearTimeout,
  });
  await mobile.ready;
  expect(get('lane-list').children[0].textContent).toContain('1 running · target 2');
  expect(get('lane-list').children[0].children[0].textContent).toContain('Held');
  expect(get('running-list').children).toHaveLength(1);
  expect(get('merge-list').children.map(li => li.children[0].textContent)).toEqual(['RQ-new · personal', 'RQ-old · personal']);
  const card = get('running-list').children[0].children[0];
  expect(card.textContent).toContain('<img'); expect(card.children).toHaveLength(0);
  card.onclick!(); expect(get('detail').open).toBe(true); expect(get('detail-body').textContent).toContain('RQ-live');
  ok = false; await mobile.poll();
  expect(get('stale').hidden).toBe(false); expect(get('stale').textContent).toContain('Stale');
  expect(get('running-list').children[0].children[0]).toBe(card);
  ok = true; data = { nodes: null }; await mobile.poll(); expect(get('stale').textContent).toContain('Stale');
  data = { nodes: [], errors: { 'jobs.jsonl': 'missing' } }; await mobile.poll();
  expect(get('stale').textContent).toContain('Partial'); expect(get('detail-title').textContent).toContain('no longer');
  data = { nodes: [], errors: {} }; await mobile.poll(); expect(get('stale').hidden).toBe(true);
  expect(get('running-list').children[0].textContent).toBe('No running jobs.');
  get('close').onclick!(); expect(get('detail').open).toBe(false);
  expect(scheduled).toBe(calls); mobile.stop(); await mobile.poll(); expect(calls).toBe(5);
});
test('initial network failure is visible and stopped clients ignore late responses', async () => {
  const { doc, get } = fixture();
  const mobile = mountMobile(doc, { fetcher: async () => { throw Error('offline'); } });
  await mobile.ready; expect(get('stale').hidden).toBe(false); expect(get('stale').textContent).toContain('unavailable'); mobile.stop();
  let finish!: (response: Response) => void;
  const late = mountMobile(doc, { fetcher: () => new Promise(resolve => { finish = resolve; }) });
  late.stop(); finish(Response.json(graph)); await late.ready;
  expect(get('running-list').children).toHaveLength(0);
});
