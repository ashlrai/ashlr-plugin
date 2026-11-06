import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { completionReceipt, jobLog, POLICY_FILES, releaseEnvironment, runGate,
  sourceInventory, validateJobs, validateLatest, validatePolicy, validateRun } from '../scripts/release-ci-gate.mjs';

const C = 'a'.repeat(40), P = 'b'.repeat(40), MAIN = 'c'.repeat(40);
const TAG = 'v1.38.3', RUN = 101, ATTEMPT = 2;
const env = { GITHUB_REPOSITORY: 'ashlrai/ashlr-plugin', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'ashlrai/ashlr-plugin/.github/workflows/release.yml@refs/heads/main',
  GITHUB_SHA: P, RELEASE_TAG: TAG, RELEASE_CI_RUN_ID: String(RUN), RELEASE_CI_ATTEMPT: String(ATTEMPT), RELEASE_CI_SOURCE: C };
const digest = value => createHash('sha256').update(value).digest('hex');
const policyBytes = 'synthetic reviewed policy bytes\n';
const hashes = Object.fromEntries(POLICY_FILES.map(path => [path, digest(policyBytes)]));
const inventory = { files: 1, inventorySha256: digest('__tests__/only.test.ts\n') };
function run() { return { id: RUN, run_attempt: ATTEMPT, repository: { id: 1211085901 },
  head_repository: { id: 1211085901, full_name: 'ashlrai/ashlr-plugin' }, workflow_id: 261059117,
  path: '.github/workflows/ci.yml', event: 'workflow_dispatch', head_sha: C, head_branch: TAG,
  status: 'completed', conclusion: 'success' }; }
function jobs() {
  const names = ['fast checks', 'Secret-shape scan', 'linux checks', 'checks (macos-latest)',
    'checks (windows-latest)', 'integration-windows', 'CI Gate', 'benchmark', 'Daily fixup queue'];
  return { total_count: names.length, jobs: names.map((name, i) => ({ id: 201 + i, run_id: RUN,
    run_attempt: ATTEMPT, name, status: 'completed', conclusion: name === 'benchmark' ? 'skipped' : 'success',
    steps: [{ name: 'Unit tests', status: 'completed', conclusion: 'success' }] })) };
}
function receipt(platform) { return { schema: 'ashlr.root-test-completion.v1', ...inventory, platform,
  tests: 2, assertions: 2, skipped: 0, failures: 0, errors: 0, bunVersion: '1.4.4', reportSha256: 'd'.repeat(64) }; }
const logged = data => `2026-11-06T00:00:00.000Z ROOT_TEST_COMPLETION ${JSON.stringify(data)}\n`;
function policyEvidence() { return {
  repo: { id: 1211085901, full_name: 'ashlrai/ashlr-plugin', default_branch: 'main' },
  branch: { protected: true, commit: { sha: MAIN } },
  ciWorkflow: { id: 261059117, path: '.github/workflows/ci.yml', state: 'active' },
  releaseWorkflow: { id: 262637531, path: '.github/workflows/release.yml', state: 'active' },
  rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI Gate', integration_id: 15368 }] } }],
  ancestry: { [C]: { status: 'ahead', merge_base_commit: { sha: C } }, [P]: { status: 'ahead', merge_base_commit: { sha: P } } },
  files: Object.fromEntries(POLICY_FILES.map(path => [path, [hashes[path], hashes[path], hashes[path]]])),
  manifests: [1, 2, 3].map(() => ({ version: '1.38.3', scripts: { test: 'bun run scripts/run-root-tests.ts' } })),
}; }
const input = { tag: TAG, source: C, policySha: P };

test('live protected policy allows app/docs main advances but rejects revoked or forged policy', () => {
  expect(() => validatePolicy(input, policyEvidence(), hashes)).not.toThrow();
  const changes = [e => { e.branch.protected = false; }, e => { e.rules = []; },
    e => { e.ciWorkflow.state = 'disabled_manually'; }, e => { e.releaseWorkflow.id++; },
    e => { e.repo.id++; }, e => { e.ancestry[C].status = 'diverged'; },
    e => { e.ancestry[P].merge_base_commit.sha = C; },
    e => { e.files['scripts/root-test-completion.ts'][2] = 'f'.repeat(64); },
    e => { e.manifests[0].scripts.test = 'echo false-success'; },
    e => { e.manifests[0].version = '1.38.2'; }];
  for (const change of changes) { const e = policyEvidence(); change(e); expect(() => validatePolicy(input, e, hashes)).toThrow(); }
});

test('exact manual workflow, canonical repository, tag, source and current attempt are all required', () => {
  expect(() => validateRun(run(), C, TAG, RUN, ATTEMPT, true)).not.toThrow();
  for (const patch of [{ event: 'push' }, { head_branch: 'main' }, { head_sha: P }, { workflow_id: 1 },
    { path: '.github/workflows/other.yml' }, { run_attempt: 3 }, { id: 102 },
    { head_repository: { id: 1, full_name: 'fork/ashlr-plugin' } },
    { status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { conclusion: 'skipped' }]) {
    expect(() => validateRun({ ...run(), ...patch }, C, TAG, RUN, ATTEMPT, true)).toThrow();
  }
});

test('all seven real full jobs plus the known manual-event inventory must complete on one attempt', () => {
  expect(validateJobs(jobs(), RUN, ATTEMPT)).toHaveLength(9);
  for (const change of [j => { j.jobs.pop(); j.total_count--; }, j => { j.jobs[0] = j.jobs[1]; },
    j => { j.jobs[2].conclusion = 'skipped'; }, j => { j.jobs[4].run_attempt++; },
    j => { j.jobs[5].conclusion = 'failure'; }, j => { j.jobs[7].conclusion = 'success'; },
    j => { j.jobs[2].steps[0].conclusion = 'skipped'; }]) {
    const doc = jobs(); change(doc); expect(() => validateJobs(doc, RUN, ATTEMPT)).toThrow();
  }
});

test('parent receipts bind the source inventory and OS; nested failure output is harmless', () => {
  const log = '(fail) deliberate nested fixture\n0 pass\n1 fail\n' + logged(receipt('win32'));
  expect(completionReceipt(log, inventory, 'win32')).toEqual(receipt('win32'));
  for (const patch of [{ inventorySha256: 'f'.repeat(64) }, { files: 2 }, { platform: 'linux' },
    { failures: 1 }, { errors: 1 }, { tests: 0 }, { tests: 2, skipped: 2 }, { assertions: 0 }, { privateBody: 'must not be stored' }]) {
    expect(() => completionReceipt(logged({ ...receipt('win32'), ...patch }), inventory, 'win32')).toThrow();
  }
  expect(() => completionReceipt('old false-green job with no completion receipt', inventory, 'win32')).toThrow();
  expect(() => completionReceipt(logged(receipt('win32')).repeat(2), inventory, 'win32')).toThrow();
  expect(() => completionReceipt('ROOT_TEST_COMPLETION not-json\n', inventory, 'win32')).toThrow();
});

test('source tree inventory is complete, regular, distinct and deterministic', () => {
  const tree = { truncated: false, tree: [{ path: '__tests__/only.test.ts', type: 'blob', mode: '100644' }] };
  expect(sourceInventory(tree)).toEqual(inventory);
  expect(() => sourceInventory({ ...tree, truncated: true })).toThrow();
  expect(() => sourceInventory({ ...tree, tree: [...tree.tree, ...tree.tree] })).toThrow();
  expect(() => sourceInventory({ ...tree, tree: [{ ...tree.tree[0], mode: '120000' }] })).toThrow();
});

test('older qualified candidates cannot replace newer public stable releases', () => {
  expect(() => validateLatest(TAG, null)).not.toThrow();
  expect(() => validateLatest(TAG, { draft: false, prerelease: false, tag_name: 'v1.38.1' })).not.toThrow();
  expect(() => validateLatest(TAG, { draft: false, prerelease: false, tag_name: TAG })).not.toThrow();
  expect(() => validateLatest(TAG, { draft: false, prerelease: false, tag_name: 'v1.38.4' })).toThrow();
});

function harness(options = {}) {
  let time = 0, dispatched = 0, listed = 0, read = 0, branchReads = 0;
  let available = options.available ?? true;
  const evidence = policyEvidence();
  const api = async (path, request) => {
    if (path === `git/ref/tags/${TAG}`) return { object: { type: 'commit', sha: C } };
    if (path === '') return evidence.repo;
    if (path === 'branches/main') { branchReads++; return evidence.branch; }
    if (path === 'actions/workflows/ci.yml') return evidence.ciWorkflow;
    if (path === 'actions/workflows/release.yml') return evidence.releaseWorkflow;
    if (path === 'rules/branches/main') return evidence.rules;
    if (path.startsWith('compare/')) return evidence.ancestry[path.slice(8, 48)];
    if (path.startsWith('contents/package.json?')) return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(evidence.manifests[0])).toString('base64') };
    if (path.startsWith('contents/')) {
      const file = path.slice(9).split('?')[0];
      const changed = options.revoke && branchReads > 1 && file === 'scripts/root-test-completion.ts';
      return { type: 'file', path: file, encoding: 'base64', size: 32, content: Buffer.from(changed ? 'revoked policy' : policyBytes).toString('base64') };
    }
    if (path === 'releases/latest') return { draft: false, prerelease: false, tag_name: 'v1.38.1' };
    if (path.startsWith('actions/workflows/ci.yml/runs?')) { listed++; return { total_count: available ? 1 : 0, workflow_runs: available ? [run()] : [] }; }
    if (path === 'actions/workflows/ci.yml/dispatches') {
      dispatched++; expect(request).toEqual({ method: 'POST', body: { ref: TAG } });
      available = !options.neverVisible;
      if (options.uncertain) throw new Error('synthetic lost response');
      return undefined;
    }
    if (path === `actions/runs/${RUN}`) {
      read++; const value = run();
      if (options.rerun && read > 1) value.run_attempt++;
      if (options.pending) { value.status = 'in_progress'; value.conclusion = null; }
      return value;
    }
    if (path === `actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`) return jobs();
    if (path === `git/trees/${C}?recursive=1`) return { truncated: false, tree: [{ path: '__tests__/only.test.ts', type: 'blob', mode: '100644' }] };
    throw new Error(`Unexpected synthetic API path: ${path}`);
  };
  const logs = async id => logged(receipt({ 203: 'linux', 204: 'darwin', 205: 'win32' }[id]));
  return { deps: { api, logs, hashes, now: () => time, sleep: async ms => { time += ms; } },
    counts: () => ({ dispatched, listed, read, time }) };
}

test('receive existing exact-tag full proof and recheck without dispatching duplicate CI', async () => {
  const h = harness(); const result = await runGate('qualify', env, h.deps);
  expect(result).toMatchObject({ source: C, tag: TAG, runId: RUN, attempt: ATTEMPT, inventory });
  expect(h.counts().dispatched).toBe(0);
  expect(Object.keys(result.receipts)).toHaveLength(3);
});
test('one uncertain dispatch is reconciled read-only, never resent', async () => {
  const h = harness({ available: false, uncertain: true });
  expect((await runGate('qualify', env, h.deps)).runId).toBe(RUN);
  expect(h.counts().dispatched).toBe(1); expect(h.counts().listed).toBeGreaterThan(1);
  const missing = harness({ available: false, uncertain: true, neverVisible: true });
  await expect(runGate('qualify', env, missing.deps)).rejects.toThrow('no-resend');
  expect(missing.counts().dispatched).toBe(1);
});
test('a pending full run is reused and bounded, without dispatch after deadline', async () => {
  const h = harness({ pending: true });
  await expect(runGate('qualify', env, h.deps)).rejects.toThrow('deadline');
  expect(h.counts().dispatched).toBe(0);
});
test('pre-write verification rejects rerun races and live policy revocation', async () => {
  for (const options of [{ rerun: true }, { revoke: true }]) {
    const h = harness(options);
    await expect(runGate('verify', env, h.deps)).rejects.toThrow();
    expect(h.counts().dispatched).toBe(0);
  }
  const h = harness(); expect((await runGate('verify', env, h.deps)).runId).toBe(RUN);
});
test('only canonical push/manual invocation can qualify, with no qualifier OIDC', () => {
  expect(releaseEnvironment(env, 'qualify').tag).toBe(TAG);
  for (const patch of [{ GITHUB_REF: 'refs/heads/fork' }, { GITHUB_REPOSITORY: 'fork/ashlr-plugin' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'FAKE_UNUSABLE_TEST_VALUE' }]) {
    expect(() => releaseEnvironment({ ...env, ...patch }, 'qualify')).toThrow();
  }
});

const savedFetch = globalThis.fetch, savedToken = process.env.GH_TOKEN;
afterEach(() => { globalThis.fetch = savedFetch; if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken; });
test('signed log redirects are credential-free and unexpected hosts are refused', async () => {
  process.env.GH_TOKEN = 'FAKE_UNUSABLE_TEST_VALUE'; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://fixture.blob.core.windows.net/log?sig=FAKE' } });
    return new Response('safe fixture log');
  };
  expect(await jobLog(42)).toBe('safe fixture log');
  expect(calls[0].options.headers.Authorization).toBe('Bearer FAKE_UNUSABLE_TEST_VALUE');
  expect(calls[1].options.headers).toBeUndefined(); expect(calls[1].options.redirect).toBe('error');
  calls.length = 0;
  globalThis.fetch = async () => { calls.push(1); return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/log' } }); };
  await expect(jobLog(42)).rejects.toThrow('untrusted-job-log-host'); expect(calls).toHaveLength(1);
});

test('workflow roles preserve full qualification and fresh checks before every external write', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  expect(workflow.concurrency).toEqual({ group: 'plugin-release', 'cancel-in-progress': false });
  expect(workflow.jobs.qualify.permissions).toEqual({ contents: 'read', actions: 'write' });
  expect(workflow.jobs.qualify.permissions['id-token']).toBeUndefined();
  expect(workflow.jobs.release.needs).toBe('qualify');
  expect(workflow.jobs['npm-publish'].needs).toEqual(['qualify', 'release']);
  expect(workflow.jobs.release.permissions.actions).toBe('read');
  expect(workflow.jobs['npm-publish'].permissions).toEqual({ contents: 'read', actions: 'read', 'id-token': 'write' });
  expect(workflow.jobs.release.env.GH_TOKEN).toBeUndefined();
  for (const job of [workflow.jobs.qualify, workflow.jobs.release]) {
    for (const step of job.steps.filter(step => step.uses?.startsWith('actions/setup-node@'))) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  }
  const writes = [...workflow.jobs.release.steps, ...workflow.jobs['npm-publish'].steps].filter(step => /gh release (?:create|upload)|npm publish/.test(step.run ?? ''));
  expect(writes).toHaveLength(4);
  for (const step of writes) {
    expect(step.run.startsWith("set -euo pipefail\n")).toBe(true);
    expect(step.run).toMatch(/(?:^|\n)[ \t]*node scripts\/release-ci-gate\.mjs verify\n[ \t]*(?:gh release|npm publish)/);
  }
});
