/** Reuse the canonical full CI workflow; never treat a fast push gate as full CI. */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'ashlrai/ashlr-plugin';
export const REPOSITORY_ID = 1211085901;
export const CI_WORKFLOW_ID = 261059117;
const RELEASE_WORKFLOW_ID = 262637531;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const POLICY_FILES = ['.github/workflows/release.yml', '.github/workflows/ci.yml',
  'scripts/release-ci-gate.mjs', 'scripts/run-root-tests.ts', 'scripts/root-test-completion.ts'];
export const REQUIRED_JOBS = ['fast checks', 'Secret-shape scan', 'linux checks',
  'checks (macos-latest)', 'checks (windows-latest)', 'integration-windows', 'CI Gate'];
const OS_JOBS = { 'linux checks': 'linux', 'checks (macos-latest)': 'darwin', 'checks (windows-latest)': 'win32' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function require(value, reason) { if (!value) throw new Error(reason); }
function integer(value) { require(Number.isSafeInteger(value) && value > 0, 'invalid-evidence-integer'); return value; }
function version(tag) {
  require(typeof tag === 'string' && tag.length <= 128 && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag), 'invalid-release-tag');
  return tag.slice(1);
}
function list(doc, key) {
  require(Number.isSafeInteger(doc.total_count) && doc.total_count <= 100 && Array.isArray(doc[key]) &&
    doc[key].length === doc.total_count, 'incomplete-evidence-inventory');
  return doc[key];
}
export function releaseEnvironment(env, mode) {
  version(env.RELEASE_TAG);
  require(env.GITHUB_REPOSITORY === REPO && SHA.test(env.GITHUB_SHA ?? ''), 'release-environment-mismatch');
  const ref = env.GITHUB_EVENT_NAME === 'push' ? `refs/tags/${env.RELEASE_TAG}` : 'refs/heads/main';
  require(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && env.GITHUB_REF === ref &&
    env.GITHUB_WORKFLOW_REF === `${REPO}/.github/workflows/release.yml@${ref}`, 'untrusted-release-invocation');
  if (mode === 'qualify') require(!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && !env.ACTIONS_ID_TOKEN_REQUEST_URL, 'qualifier-must-have-no-oidc');
  return { tag: env.RELEASE_TAG, policySha: env.GITHUB_SHA };
}
export function matchesRun(run, source, tag) {
  return run?.repository?.id === REPOSITORY_ID && run.head_repository?.id === REPOSITORY_ID &&
    run.head_repository?.full_name === REPO && run.workflow_id === CI_WORKFLOW_ID &&
    run.path === '.github/workflows/ci.yml' && run.event === 'workflow_dispatch' &&
    run.head_sha === source && run.head_branch === tag && run.display_title === 'ci/full';
}
export function validateRun(run, source, tag, id, attempt, completed = false) {
  integer(id); integer(attempt);
  require(matchesRun(run, source, tag) && run.id === id && run.run_attempt === attempt, 'ci-run-or-attempt-binding-changed');
  if (completed) require(run.status === 'completed' && run.conclusion === 'success', 'canonical-full-ci-not-successful');
  else if (run.status === 'completed') require(run.conclusion === 'success', 'canonical-full-ci-failed');
}
export function sourceInventory(tree) {
  require(tree.truncated === false && Array.isArray(tree.tree), 'truncated-source-tree');
  const files = tree.tree.filter(row => row.path?.startsWith('__tests__/') && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(row.path));
  require(files.length > 0 && files.every(row => row.type === 'blob' && ['100644', '100755'].includes(row.mode)), 'invalid-source-test-inventory');
  const names = files.map(row => row.path).sort((a, b) => Number(a > b) - Number(a < b));
  require(new Set(names).size === names.length, 'duplicate-source-test-file');
  return { files: names.length, inventorySha256: hash(names.join('\n') + '\n') };
}
export function completionReceipt(log, inventory, platform) {
  require(Buffer.byteLength(log) <= 32 * 1024 * 1024, 'job-log-too-large');
  const rows = log.split(/\r?\n/).map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z /, ''))
    .filter(line => line.startsWith('ROOT_TEST_COMPLETION '));
  require(rows.length === 1, 'missing-or-duplicate-parent-completion-receipt');
  let receipt;
  try { receipt = JSON.parse(rows[0].slice('ROOT_TEST_COMPLETION '.length)); }
  catch { throw new Error('invalid-parent-completion-json'); }
  require(receipt.schema === 'ashlr.root-test-completion.v1' && receipt.platform === platform &&
    receipt.files === inventory.files && receipt.inventorySha256 === inventory.inventorySha256 &&
    receipt.failures === 0 && receipt.errors === 0 && HASH.test(receipt.reportSha256 ?? '') &&
    typeof receipt.bunVersion === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(receipt.bunVersion), 'parent-completion-binding-mismatch');
  for (const key of ['tests', 'assertions', 'skipped']) require(Number.isSafeInteger(receipt[key]) && receipt[key] >= 0 && receipt[key] < 1e10, 'invalid-completion-count');
  require(receipt.tests >= receipt.files && receipt.tests > receipt.skipped && receipt.assertions > 0, 'empty-or-incomplete-root-tests');
  const keys = ['schema', 'files', 'tests', 'assertions', 'skipped', 'platform', 'bunVersion', 'inventorySha256', 'failures', 'errors', 'reportSha256'];
  require(Object.keys(receipt).length === keys.length && keys.every(key => Object.hasOwn(receipt, key)), 'unexpected-completion-fields');
  return Object.fromEntries(keys.map(key => [key, receipt[key]]));
}
export function validateJobs(doc, runId, attempt) {
  const jobs = list(doc, 'jobs');
  const expected = [...REQUIRED_JOBS, 'benchmark', 'Daily fixup queue'];
  require(jobs.length === expected.length && new Set(jobs.map(job => job.id)).size === jobs.length, 'ci-job-inventory-drift');
  for (const name of expected) {
    const found = jobs.filter(job => job.name === name);
    require(found.length === 1, 'ci-job-missing-or-duplicated');
    const job = found[0]; integer(job.id);
    require(job.run_id === runId && job.run_attempt === attempt && job.status === 'completed' &&
      job.conclusion === (name === 'benchmark' ? 'skipped' : 'success'), 'ci-job-incomplete-failed-or-mixed-attempt');
    if (name === 'fast checks') {
      const scope = job.steps?.filter(step => step.name === 'Full qualification scope');
      require(scope?.length === 1 && scope[0].status === 'completed' && scope[0].conclusion === 'success', 'full-scope-step-did-not-succeed');
    }
    if (name in OS_JOBS) {
      const unit = job.steps?.filter(step => step.name === 'Unit tests');
      require(unit?.length === 1 && unit[0].status === 'completed' && unit[0].conclusion === 'success', 'root-unit-step-did-not-succeed');
    }
  }
  return jobs;
}
export function validatePolicy(input, evidence, localHashes) {
  const { branch, repo, ciWorkflow, releaseWorkflow, ancestry, rules, files, manifests } = evidence;
  require(repo.id === REPOSITORY_ID && repo.full_name === REPO && repo.default_branch === 'main' &&
    branch.protected === true && SHA.test(branch.commit?.sha ?? ''), 'canonical-main-protection-missing');
  require(ciWorkflow.id === CI_WORKFLOW_ID && ciWorkflow.path === '.github/workflows/ci.yml' && ciWorkflow.state === 'active' &&
    releaseWorkflow.id === RELEASE_WORKFLOW_ID && releaseWorkflow.path === '.github/workflows/release.yml' && releaseWorkflow.state === 'active', 'canonical-workflow-changed-or-disabled');
  require(rules.some(rule => rule.type === 'required_status_checks' && rule.parameters?.required_status_checks?.some(check =>
    check.context === 'CI Gate' && check.integration_id === 15368)), 'canonical-ci-protection-revoked');
  for (const commit of [input.source, input.policySha]) {
    require(SHA.test(commit) && ['ahead', 'identical'].includes(ancestry[commit]?.status) &&
      ancestry[commit].merge_base_commit?.sha === commit, 'candidate-or-policy-left-protected-history');
  }
  for (const path of POLICY_FILES) {
    require(HASH.test(localHashes[path] ?? '') && files[path]?.length === 3 &&
      files[path].every(digest => digest === localHashes[path]), 'release-policy-closure-changed');
  }
  require(manifests.length === 3 && manifests.every(manifest => manifest.scripts?.test === 'bun run scripts/run-root-tests.ts') &&
    manifests[0].version === version(input.tag), 'canonical-test-wrapper-or-version-mismatch');
}
export function validateLatest(tag, latest) {
  if (latest === null) return;
  require(latest.draft === false && latest.prerelease === false, 'invalid-latest-stable');
  const candidate = version(tag).split('.').map(BigInt), published = version(latest.tag_name).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (candidate[i] > published[i]) return;
    require(candidate[i] >= published[i], 'newer-public-release-already-exists');
  }
}

// The same bounded API + manual credential-free redirect pattern used by the
// reviewed Lexicon recovery. Credentials never reach a signed log URL.
async function bounded(response, limit) {
  require(Number(response.headers.get('content-length') ?? 0) <= limit && response.body, 'bounded-response-unavailable');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
    require(bytes <= limit, 'bounded-response-exceeded'); chunks.push(next.value); } }
  finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  return Buffer.concat(chunks, bytes);
}
async function request(path, { method = 'GET', body, redirect = 'error' } = {}) {
  try {
    return await fetch(`https://api.github.com/repos/${REPO}${path ? `/${path}` : ''}`, { method, redirect,
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('github-evidence-unavailable'); }
}
async function json(path, options) {
  const response = await request(path, options);
  if (path === 'releases/latest' && response.status === 404) return null;
  require(response.status === (options?.method === 'POST' ? 204 : 200), 'github-evidence-unavailable');
  if (response.status === 204) return undefined;
  try { return JSON.parse((await bounded(response, 8 * 1024 * 1024)).toString('utf8')); }
  catch { throw new Error('github-json-evidence-unavailable'); }
}
export async function jobLog(id) {
  integer(id);
  const response = await request(`actions/jobs/${id}/logs`, { redirect: 'manual' });
  require(response.status === 302, 'job-log-redirect-unavailable');
  const url = new URL(response.headers.get('location'));
  require(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com')), 'untrusted-job-log-host');
  const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  require(download.status === 200, 'job-log-unavailable');
  return (await bounded(download, 32 * 1024 * 1024)).toString('utf8');
}
async function resolveTag(tag, api) {
  let object = (await api(`git/ref/tags/${tag}`)).object;
  for (let depth = 0; object?.type === 'tag' && depth < 3; depth++) object = (await api(`git/tags/${object.sha}`)).object;
  require(object?.type === 'commit' && SHA.test(object.sha), 'invalid-tag-source'); return object.sha;
}
async function policy(input, api, hashes) {
  const [branch, repo, ciWorkflow, releaseWorkflow, rules] = await Promise.all([
    api('branches/main'), api(''), api('actions/workflows/ci.yml'), api('actions/workflows/release.yml'), api('rules/branches/main'),
  ]);
  const commits = [input.source, input.policySha, branch.commit.sha];
  const ancestry = Object.fromEntries(await Promise.all([...new Set(commits.slice(0, 2))].map(async sha => [sha, await api(`compare/${sha}...${branch.commit.sha}`)])));
  const files = Object.fromEntries(await Promise.all(POLICY_FILES.map(async path => [path, await Promise.all(commits.map(async sha => {
    const file = await api(`contents/${path}?ref=${sha}`);
    require(file.type === 'file' && file.path === path && file.encoding === 'base64' && file.size <= 1024 * 1024, 'invalid-policy-file');
    return hash(Buffer.from(file.content, 'base64'));
  }))])));
  const manifests = await Promise.all(commits.map(async sha => {
    const file = await api(`contents/package.json?ref=${sha}`); require(file.type === 'file' && file.encoding === 'base64', 'package-manifest-unavailable');
    try { return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); }
    catch { throw new Error('package-manifest-invalid-json'); }
  }));
  validatePolicy(input, { branch, repo, ciWorkflow, releaseWorkflow, rules, ancestry, files, manifests }, hashes);
  validateLatest(input.tag, await api('releases/latest'));
}
export async function runGate(mode, env, deps = {}) {
  require(['qualify', 'verify'].includes(mode), 'invalid-qualification-mode');
  const input = releaseEnvironment(env, mode), api = deps.api ?? json, logs = deps.logs ?? jobLog;
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const hashes = deps.hashes ?? Object.fromEntries(POLICY_FILES.map(path => [path, hash(readFileSync(resolve(ROOT, path)))]));
  input.source = await resolveTag(input.tag, api);
  await policy(input, api, hashes);
  let runId, attempt;
  if (mode === 'verify') {
    runId = Number(env.RELEASE_CI_RUN_ID); attempt = Number(env.RELEASE_CI_ATTEMPT);
    require(env.RELEASE_CI_SOURCE === input.source, 'qualified-tag-source-moved');
  } else {
    const eligible = async () => list(await api(`actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${input.source}&per_page=100`), 'workflow_runs')
      .filter(run => matchesRun(run, input.source, input.tag)).sort((a, b) => b.id - a.id);
    let found = (await eligible())[0];
    if (!found) {
      // Exactly one dispatch attempt. A lost response is reconciled by reads;
      // it is never retried or converted into another expensive CI run.
      try { await api('actions/workflows/ci.yml/dispatches', { method: 'POST', body: { ref: input.tag, inputs: { validation_scope: 'full' } } }); }
      catch { /* uncertain dispatch: poll only */ }
      const deadline = now() + 120_000;
      while (!found && now() < deadline) { await sleep(5_000); found = (await eligible())[0]; }
      require(found, 'canonical-ci-dispatch-unresolved-no-resend');
    }
    runId = integer(found.id); attempt = integer(found.run_attempt);
    const deadline = now() + 45 * 60_000;
    for (;;) {
      const run = await api(`actions/runs/${runId}`); validateRun(run, input.source, input.tag, runId, attempt);
      if (run.status === 'completed') break;
      require(now() < deadline, 'canonical-full-ci-deadline'); await sleep(15_000);
    }
  }
  integer(runId); integer(attempt);
  const run = await api(`actions/runs/${runId}`); validateRun(run, input.source, input.tag, runId, attempt, true);
  const jobs = validateJobs(await api(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`), runId, attempt);
  const inventory = sourceInventory(await api(`git/trees/${input.source}?recursive=1`));
  const receipts = Object.fromEntries(await Promise.all(Object.entries(OS_JOBS).map(async ([name, platform]) => {
    const job = jobs.find(job => job.name === name);
    return [name, completionReceipt(await logs(job.id), inventory, platform)];
  })));
  // Fresh live checks stay outside the frozen source/run/attempt tuple. Main
  // may advance through app/docs work, but policy revocation/reruns stop writes.
  await policy(input, api, hashes);
  require(await resolveTag(input.tag, api) === input.source, 'tag-source-changed');
  validateRun(await api(`actions/runs/${runId}`), input.source, input.tag, runId, attempt, true);
  return { schema: 'ashlr.release-full-ci.v1', tag: input.tag, source: input.source, runId, attempt, inventory, receipts };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runGate(process.argv[2], process.env);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `ci_run_id=${result.runId}\nci_attempt=${result.attempt}\nsource_sha=${result.source}\n`);
    console.log(`Qualified canonical full CI ${result.runId} attempt ${result.attempt} for ${result.tag} (${result.source})`);
  } catch (error) {
    console.error(`Release qualification refused: ${error instanceof Error ? error.message : 'unavailable evidence'}`);
    process.exitCode = 1;
  }
}
