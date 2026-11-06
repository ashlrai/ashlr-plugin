import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountMobile } from '../scripts/fleet-ui/mobile.js';
import { startFleetUi } from '../scripts/fleet-ui-server';
class Element {
  textContent = ''; children: Element[] = []; open = false; href = ''; rel = '';
  onclick?: () => unknown; onclose?: () => void;
  append(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.onclose?.(); }
}
test('job tap opens full-screen live session, updates state, rejects hostile links and stops on close/hidden', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-session-'))), elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: get, createElement: () => new Element() });
  mkdirSync(join(root, 'fleet')); mkdirSync(join(root, 'metrics'));
  const job = { job_id: 'RQ-1', state: 'running', codex_url: 'https://chatgpt.com/c/1', claude_url: 'https://claude.ai.evil.example/session' };
  writeFileSync(join(root, 'fleet/jobs.jsonl'), JSON.stringify(job) + '\n');
  writeFileSync(join(root, 'dispatch-events.log'), '{"job_id":"RQ-1","type":"started"}\n');
  writeFileSync(join(root, 'metrics/jobs.jsonl'), '');
  const server = startFleetUi({ root, port: 0 }), base = `http://127.0.0.1:${server.port}`;
  let sequence = 0, tailCalls = 0, fail = false, late: (() => void) | undefined, signal: AbortSignal | undefined;
  const timers = new Map<number, { fn: () => Promise<void>; ms: number }>();
  const mobile = mountMobile(doc as unknown as Document, {
    fetcher: async (path, init) => {
      if (path.startsWith('/api/log-tail')) {
        tailCalls++; signal = init?.signal ?? undefined;
        if (fail) return new Response('', { status: 503 });
        if (late) return new Promise(resolve => { late = () => resolve(Response.json({ lines: ['obsolete'] })); });
      }
      return fetch(base + path, init);
    },
    schedule: ((fn: () => Promise<void>, ms: number) => { timers.set(++sequence, { fn, ms }); return sequence; }) as unknown as typeof setTimeout,
    cancel: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
  });
  const tick = async () => { const [id, timer] = [...timers].find(([, value]) => value.ms === 1500)!; timers.delete(id); await timer.fn(); };
  try {
    await mobile.ready; await get('running-list').children[0].children[0].onclick!();
    expect(get('detail').open).toBe(true); expect(get('detail-state').textContent).toBe('running');
    expect(get('detail-links').children.map(a => a.href)).toEqual(['https://chatgpt.com/c/1']);
    expect(get('detail-links').children[0].rel).toBe('noopener noreferrer');
    expect(get('detail-body').textContent).toContain('started');
    appendFileSync(join(root, 'dispatch-events.log'), '{"job_id":"RQ-1","type":"finished"}\n');
    await tick(); expect(get('detail-body').textContent.split('\n')).toHaveLength(2);
    fail = true; await tick(); expect(get('detail-status').textContent).toContain('Disconnected');
    expect(get('detail-body').textContent).toContain('finished'); fail = false;
    await tick(); expect(get('detail-status').textContent).toBe('Live');
    appendFileSync(join(root, 'fleet/jobs.jsonl'), JSON.stringify({ ...job, state: 'merged' }) + '\n');
    await mobile.poll(); expect(get('detail-state').textContent).toBe('merged');
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    const calls = tailCalls; await mobile.poll(); expect(timers.size).toBe(0); expect(tailCalls).toBe(calls); expect(signal?.aborted).toBe(true);
    late = () => {}; doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    expect(tailCalls).toBe(calls + 1);
    get('close').onclick!(); expect(get('detail').open).toBe(false); expect(signal?.aborted).toBe(true);
    late!(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(get('detail-body').textContent).not.toContain('obsolete');
    expect([...timers.values()].some(timer => timer.ms === 1500)).toBe(false);
    late = undefined; await get('merge-list').children[0].children[0].onclick!();
    get('detail').close(); expect(signal?.aborted).toBe(true);
    const asset = await fetch(base + '/mobile-session.js'); expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toContain("from './session-panel.js'");
    const html = await (await fetch(base + '/mobile')).text(); expect(html).toContain('height:100dvh;max-height:none');
  } finally { mobile.stop(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
