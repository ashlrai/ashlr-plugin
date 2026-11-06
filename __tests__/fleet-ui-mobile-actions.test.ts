import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileActions, mountMobileActions } from '../scripts/fleet-ui/mobile-actions.js';
import { startFleetUi } from '../scripts/fleet-ui-server';
class Element {
  textContent = ''; children: Element[] = []; type = ''; value = ''; disabled = false;
  onclick?: () => unknown;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
}
function fixture() {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = { getElementById: get, createElement: () => new Element() } as unknown as Document;
  return { doc, get };
}
const lane = (name: string) => ({ id: `lane:${name}`, kind: 'lane', lane: name, details: {} });
const job = (id: string, state = 'running') => ({ id: `job:${id}`, kind: 'job', lane: 'personal', details: { job_id: id, state } });
test('pause and resume queue without a dialog; kill prompts then sends the confirmed contract', async () => {
  const sent: unknown[] = [], announced: string[] = [];
  let prompt = '';
  const run = createMobileActions(async body => { sent.push(body); return { status: 'pending', id: 'act-1' }; },
    message => { prompt = message; return true; }, message => announced.push(message));
  await run('pause', { lane: 'claude' }, 'maintenance');
  await run('resume', { lane: 'claude' }, 'maintenance done');
  expect(prompt).toBe('');
  expect(sent).toEqual([
    { confirmed: true, action: { action: 'pause', requested_by: 'fleet-ui-mobile', reason: 'maintenance', dry_run: false, lane: 'claude' } },
    { confirmed: true, action: { action: 'resume', requested_by: 'fleet-ui-mobile', reason: 'maintenance done', dry_run: false, lane: 'claude' } },
  ]);
  await run('kill', { job_id: 'RQ-9' }, 'runaway');
  expect(prompt).toContain('RQ-9');
  expect(sent[2]).toEqual({ confirmed: true, action: { action: 'kill', requested_by: 'fleet-ui-mobile', reason: 'runaway', dry_run: false, job_id: 'RQ-9' } });
  expect(announced).toHaveLength(3);
  expect(announced.every(line => line.includes('pending · act-1'))).toBe(true);
});
test('kill without confirmation sends nothing; invalid input never reaches send', async () => {
  let sends = 0, prompts = 0;
  const announced: string[] = [];
  const run = createMobileActions(async () => { sends++; }, () => { prompts++; return false; }, message => announced.push(message));
  await run('kill', { job_id: 'RQ-9' }, 'runaway');
  expect(sends).toBe(0); expect(prompts).toBe(1);
  expect(announced.at(-1)).toContain('cancelled');
  for (const [action, target, reason] of [
    ['kill', {}, 'reason'],
    ['kill', { job_id: '../bad' }, 'reason'],
    ['pause', {}, 'reason'],
    ['pause', { lane: 'claude' }, ''],
    ['resume', { lane: 'claude' }, 'x'.repeat(513)],
    ['reassign', { job_id: 'RQ-1', lane: 'claude' }, 'reason'],
  ] as const) await run(action, target, reason);
  expect(sends).toBe(0); expect(prompts).toBe(1);
  expect(announced.slice(1).every(line => line.includes('failed'))).toBe(true);
});
test('a send failure and an in-flight tap are safe and visible', async () => {
  const announced: string[] = [];
  let release!: (value: boolean) => void, sends = 0;
  const run = createMobileActions(async () => { sends++; throw Error('offline'); },
    () => new Promise<boolean>(resolve => { release = resolve; }), message => announced.push(message));
  const first = run('kill', { job_id: 'RQ-1' }, 'reason');
  await run('kill', { job_id: 'RQ-1' }, 'reason');
  release(true); await first;
  expect(sends).toBe(1);
  expect(announced.at(-1)).toBe('kill: failed · offline');
});
test('mounted controls drive the real handler through the server and show each result', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-actions-'))), server = startFleetUi({ root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const { doc, get } = fixture();
  get('remote-reason').value = 'phone remote';
  const mounted = mountMobileActions(doc, {
    send: async body => {
      const response = await fetch(base + '/api/actions', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(202); return response.json();
    },
    confirm: () => true,
  });
  try {
    mounted.update({ nodes: [lane('claude'), lane('codex'), job('RQ-1'), job('RQ-2', 'merged')] });
    const lanes = get('remote-lanes').children, jobs = get('remote-jobs').children;
    expect(lanes).toHaveLength(2);
    expect(lanes[0].children.map(button => button.textContent)).toEqual(['Pause claude', 'Resume claude']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].children[0].textContent).toBe('Kill RQ-1');
    await lanes[0].children[0].onclick!();
    await lanes[1].children[1].onclick!();
    await jobs[0].children[0].onclick!();
    const records = readFileSync(join(root, 'fleet/actions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => [record.action, record.lane ?? record.job_id])).toEqual([['pause', 'claude'], ['resume', 'codex'], ['kill', 'RQ-1']]);
    expect(records.every(record => record.status === 'pending' && record.requested_by === 'fleet-ui-mobile' && record.reason === 'phone remote')).toBe(true);
    const log = get('remote-log').textContent.split('\n').filter(Boolean);
    expect(log).toHaveLength(3);
    expect(log.every(line => line.includes('pending'))).toBe(true);
    expect(lanes[0].children[0].disabled).toBe(false);
    mounted.update({ nodes: [] });
    expect(get('remote-lanes').children[0].textContent).toBe('No lanes reported.');
    expect(get('remote-jobs').children[0].textContent).toBe('No running jobs.');
    expect((await fetch(base + '/mobile')).status).toBe(200);
    expect((await fetch(base + '/mobile-actions.js')).status).toBe(200);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
test('mobile.html remote controls keep at least 44px touch targets at a 390px viewport', () => {
  const html = readFileSync(join(import.meta.dir, '../scripts/fleet-ui/mobile.html'), 'utf8');
  expect(html).toContain('name="viewport"');
  for (const id of ['remote-reason', 'remote-lanes', 'remote-jobs', 'remote-log']) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('mobile.js');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const rules: { selector: string; body: string }[] = [];
  const walk = (sheet: string, applies: boolean) => {
    let rest = sheet;
    while (rest.includes('{')) {
      const open = rest.indexOf('{'), head = rest.slice(0, open).trim();
      let depth = 0, close = rest.length;
      for (let i = open; i < rest.length; i++) {
        if (rest[i] === '{') depth++;
        if (rest[i] === '}' && --depth === 0) { close = i; break; }
      }
      const body = rest.slice(open + 1, close);
      if (head.startsWith('@media')) {
        const max = head.match(/max-width:\s*(\d+)px/), min = head.match(/min-width:\s*(\d+)px/);
        walk(body, applies && (!max || 390 <= Number(max[1])) && (!min || 390 >= Number(min[1])));
      } else if (applies) rules.push({ selector: head, body });
      rest = rest.slice(close + 1);
    }
  };
  walk(css, true);
  const touchesRemote = (selector: string) => selector.split(',').some(part => {
    const last = part.trim().split(/\s+/).pop()!.replace(/:.*$/, '');
    return last === '*' || last === 'button' || last === 'input' || last.startsWith('#remote');
  });
  const px = (body: string, prop: string) => Number(body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(\\d+)px`))?.[1] ?? 0);
  const remote = rules.filter(rule => rule.selector.includes('#remote') && (rule.selector.includes('button') || rule.selector.includes('input')));
  expect(remote.length).toBeGreaterThan(0);
  for (const rule of remote) {
    expect(px(rule.body, 'min-height')).toBeGreaterThanOrEqual(44);
    expect(px(rule.body, 'min-width')).toBeGreaterThanOrEqual(44);
  }
  for (const rule of rules.filter(rule => touchesRemote(rule.selector)))
    for (const prop of ['min-height', 'min-width', 'height', 'width']) {
      const value = px(rule.body, prop);
      if (value) expect(value).toBeGreaterThanOrEqual(44);
    }
});
