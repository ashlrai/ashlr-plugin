import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFleetUi } from '../scripts/fleet-ui-server';
import { createSessionPanel, sessionLinks } from '../scripts/fleet-ui/session-panel.js';

test('opens a live session, resumes its offset, reports missing logs and stays local', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'panel-')));
  mkdirSync(join(root, 'fleet/logs'), { recursive: true });
  writeFileSync(join(root, 'fleet/jobs.jsonl'), JSON.stringify({ job_id: 'fake', state: 'running', codex_url: 'https://chatgpt.com/codex/fake' }) + '\n');
  const log = join(root, 'fleet/logs/fake.log');
  writeFileSync(log, 'first\npartial');
  const server = startFleetUi({ root, port: 0 }), paths: string[] = [], views: any[] = [];
  const base = `http://127.0.0.1:${server.port}`;
  const panel = createSessionPanel(async (path: string) => {
    paths.push(path); return (await fetch(base + path)).json();
  }, (view: unknown) => views.push(view));
  const node = { id: 'job:fake', kind: 'job', details: { job_id: 'fake' } };
  try {
    await panel.open(node); panel.close();
    expect(views.at(-1).lines).toEqual(['first']);
    expect(views.at(-1).state).toBe('running');
    expect(views.at(-1).links[0].name).toBe('Codex');
    appendFileSync(log, '\nnext\n');
    await panel.open(node); panel.close();
    expect(paths.at(-1)).toEndWith('offset=1');
    expect(views.at(-1).lines).toEqual(['first', 'partial', 'next']);
    writeFileSync(log, 'rotated\n');
    await panel.open(node); panel.close();
    expect(views.at(-1).lines).toEqual(['rotated']);
    writeFileSync(log, Array.from({ length: 151 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const page = await (await fetch(base + '/api/session?job=fake&offset=0')).json();
    expect(page.logs).toHaveLength(150);
    expect(page.offset).toBe(150);
    expect(page.has_more).toBe(true);
    rmSync(log);
    await panel.open(node); panel.close();
    expect(views.at(-1).state).toContain('missing');
    expect(server.hostname).toBe('127.0.0.1');
    expect((await fetch(base + '/api/session?job=fake', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    for (const query of ['job=../bad', 'job=fake&offset=-1', 'job=fake&offset=no']) expect((await fetch(base + '/api/session?' + query)).status).toBe(400);
    expect((await fetch(base + '/session-panel.js')).headers.get('content-type')).toContain('javascript');
  } finally { panel.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
test('session links allow expected HTTPS hosts only', () => {
  expect(sessionLinks({ claude_url: 'https://claude.ai/code/fake', devin_url: 'https://app.devin.ai/sessions/fake' }).map(link => link.name)).toEqual(['Claude', 'Devin']);
  for (const value of ['javascript:alert(1)', 'https://claude.ai.evil.example/fake', 'https://user@claude.ai/fake']) expect(sessionLinks({ session_url: value })).toEqual([]);
});
test('closed windows ignore late responses and lane nodes need no log request', async () => {
  let finish!: (value: { logs: string[]; offset: number; errors: {}; job: null }) => void;
  const views: any[] = [];
  const panel = createSessionPanel(() => new Promise(resolve => { finish = resolve; }), (view: unknown) => views.push(view));
  const pending = panel.open({ id: 'job:fake', kind: 'job', details: {} });
  panel.close();
  finish({ logs: ['late'], offset: 1, errors: {}, job: null });
  await pending;
  expect(views).toHaveLength(1);
  await panel.open({ id: 'lane:fake', kind: 'lane', details: { target: 2 } });
  expect(views.at(-1).state).toContain('Lane');
  panel.close();
});
