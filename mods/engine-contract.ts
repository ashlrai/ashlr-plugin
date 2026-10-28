#!/usr/bin/env bun
/** Run the real Claude engine against isolated fixtures; no provider/tool calls.
 * A 309 version stub in shape tests exercises adapter contracts only. It cannot
 * establish that an older engine honors the 309-only person decider.
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contract = String.raw`
import { test, expect } from 'claude-code/testing';

function stubProcesses(on, version = '2.1.280 (Claude Code)') {
  const calls = [];
  on('process.run', (_, e) => {
    calls.push(e);
    if (e.argv.join(' ') === 'claude --version') return { value: { exitCode: 0, stdout: version, stderr: '' } };
    if (e.argv.join(' ') === 'locus exec --no-resolve -- phm router select --json') return { value: { exitCode: 0, stdout: '{"model":"opus"}', stderr: '' } };
    throw new Error('Unexpected process request: no real command is permitted');
  });
  return calls;
}

async function drain(stream) {
  const chunks = [];
  for (;;) {
    const part = await stream.next();
    if (part.done) return { chunks, result: part.value };
    chunks.push(part.value);
  }
}

const step = { turnId: 'turn-1', index: 0, model: 'sonnet', messageCount: 1 };

test('a 2.1.280 host is refused before core policy or router access', async ($, on) => {
  const calls = stubProcesses(on);
  on('tool.check', () => { throw new Error('Core policy must not run'); });
  const result = await $.tool.check({ tool: 'Read', input: { file_path: 'README.md' } });
  expect(result.decision).toBe('deny');
  expect(result.reason).toContain('2.1.309');
  expect(calls.map(c => c.argv)).toEqual([['claude', '--version']]);
});

test('an unsupported host streams a visible failure without model dispatch', async ($, on) => {
  const calls = stubProcesses(on);
  on('turn.step', async function* () { throw new Error('No model dispatch is permitted'); });
  const { chunks, result } = await drain($.turn.step(step));
  expect(chunks.some(c => c.kind === 'text' && c.text.includes('2.1.309'))).toBe(true);
  expect(chunks.some(c => c.kind === 'stop')).toBe(true);
  expect(result.answer).toContain('2.1.309');
  expect(result.toolUses).toEqual([]);
  expect(calls.map(c => c.argv)).toEqual([['claude', '--version']]);
});

test('the real engine validates the pane tree on four surfaces', async ($, on) => {
  stubProcesses(on);
  for (const surface of ['terminal', 'desktop', 'mobile', 'vscode']) {
    const ui = await $.ui.mount({ plugin: 'phantom-contract', surface, component: 'Pane', requestId: 'phantom-top',
      props: { title: 'Phantom fleet', isFocused: false, bodyColumns: 18, placement: 'dock',
        scroll: { top: 0, bodyRows: 2, totalRows: 2 }, view: {} },
      viewport: { columns: 160, rows: 40, isFullscreen: true } });
    expect(await ui.find({ type: 'Text', text: 'Loading local Phantom fleet' })).toBeDefined();
    await ui.unmount();
  }
});

// The newer version is a transport stub, not evidence of 309 runtime support.
test('turn routing contract shape preserves the real engine stream and result', async ($, on) => {
  const calls = stubProcesses(on, '2.1.309 (Claude Code)');
  let received;
  on('turn.step', async function* (_, e) {
    received = e;
    yield { kind: 'text', index: 0, text: 'stubbed answer' };
    yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return { turnId: e.turnId, index: e.index, answer: 'stubbed answer', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  const { chunks, result } = await drain($.turn.step(step));
  expect(received).toEqual({ ...step, model: 'opus' });
  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'stubbed answer' });
  expect(result.answer).toBe('stubbed answer');
  expect(JSON.parse(calls[1].init.stdin)).toEqual({ event: 'turn.step', ...step });
});

test('subagent routing contract shape preserves spawn identity without a real spawn', async ($, on) => {
  const calls = stubProcesses(on, '2.1.309 (Claude Code)');
  let received;
  on('agent.spawn', (_, e) => { received = e; return { model: e.model, agentId: 'stub-agent' }; });
  const spawn = { tool_use_id: 'spawn-1', prompt: 'private task', description: 'inspect', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'sonnet', background: false, fork: false };
  const result = await $.agent.spawn(spawn);
  expect(received).toEqual({ ...spawn, model: 'opus' });
  expect(result).toEqual({ model: 'opus', agentId: 'stub-agent' });
  expect(JSON.parse(calls[1].init.stdin)).toEqual({ event: 'agent.spawn', model: 'sonnet', subagentType: 'Explore', fork: false });
});
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "phantom-engine-contract-"));
try {
  const plugin = join(temporary, "plugin");
  const home = join(temporary, "home");
  await Promise.all([".claude-plugin", "mods", "hooks"].map(path => mkdir(join(plugin, path), { recursive: true })));
  await mkdir(home);
  await Promise.all([
    ...["mods/register.ts", "mods/host.ts", "hooks/phantom-policy.ts"].map(path => copyFile(join(root, path), join(plugin, path))),
    writeFile(join(plugin, ".claude-plugin/plugin.json"), '{"name":"phantom-contract"}\n'),
    writeFile(join(plugin, "hooks/hooks.json"), '{"modules":["../mods/register.ts"]}\n'),
    writeFile(join(plugin, "contract.test.ts"), contract),
  ]);
  const child = Bun.spawn(["claude", "plugin", "test", plugin], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
