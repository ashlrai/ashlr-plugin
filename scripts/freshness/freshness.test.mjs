import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { plan, render, sources } from './core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const data = { version: '2.0.0', released: '1.9.0', date: '2026-10-25' };
for (const [name, expected] of [
  ['version-badge', 'version-2.0.0-blue'],
  ['install', 'npm install -g ashlr-plugin@2.0.0'],
  ['version-table', '| Latest released changelog (2026-10-25) | 1.9.0 |'],
  ['example-pin', '"ashlr-plugin": "2.0.0"'],
  ['release-summary', 'Latest documented release: [1.9.0] (2026-10-25). Package version: 2.0.0.'],
]) {
  test(`renders ${name} from authoritative metadata`, () => {
    assert.ok(render(name, data).includes(expected));
    assert.ok(!render(name, data).includes('undefined'));
  });
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-freshness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['scripts/freshness', 'docs', 'examples']) mkdirSync(join(dir, path), { recursive: true });
  cpSync(join(root, 'scripts/freshness'), join(dir, 'scripts/freshness'), { recursive: true });
  for (const path of ['README.md', 'FAQ.md', 'CHANGELOG.md', 'package.json', 'docs/README.md', 'examples/README.md']) {
    cpSync(join(root, path), join(dir, path));
  }
  return dir;
}
function cli(dir, name) {
  return spawnSync(process.execPath, [join(dir, 'scripts/freshness', `${name}.mjs`)], { encoding: 'utf8', cwd: tmpdir() });
}

test('CLI rejects seeded drift, sync repairs it, and repeated sync is idempotent', t => {
  const dir = fixture(t);
  const path = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = '9.8.7';
  writeFileSync(path, JSON.stringify(pkg));
  const stale = cli(dir, 'check');
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stdout, /Stale: README.md/);
  const before = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.equal(cli(dir, 'check').status, 1);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), before);
  assert.equal(cli(dir, 'sync').status, 0);
  assert.equal(cli(dir, 'check').status, 0);
  assert.equal(cli(dir, 'sync').stdout, '');
  assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').includes('ashlr-plugin@9.8.7'));
  assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').includes("## What's new in v1.37"));
});

for (const [label, block] of [
  ['unknown', '<!-- fresh:begin mystery -->\nx\n<!-- fresh:end -->'],
  ['unclosed', '<!-- fresh:begin install -->\nx'],
  ['orphan', '<!-- fresh:end -->'],
  ['nested', '<!-- fresh:begin install -->\n<!-- fresh:begin install -->\nx\n<!-- fresh:end -->\n<!-- fresh:end -->'],
  ['duplicate', '<!-- fresh:begin install -->\nx\n<!-- fresh:end -->\n<!-- fresh:begin install -->\nx\n<!-- fresh:end -->'],
]) {
  test(`rejects ${label} blocks before writing`, t => {
    const dir = fixture(t);
    writeFileSync(join(dir, 'docs/bad.md'), block);
    assert.throws(() => plan(dir));
    assert.equal(cli(dir, 'sync').status, 1);
  });
}

test('rejects removed required markers', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'README.md'), '# Missing generated blocks\n');
  assert.throws(() => plan(dir), /missing freshness block/);
});

test('latest stable release skips Unreleased and prereleases', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'CHANGELOG.md'), '## [Unreleased]\n\n## [3.0.0-rc.1] - 2026-10-26\n\n## [2.9.0] - 2026-10-25\n');
  assert.equal(sources(dir).released, '2.9.0');
  writeFileSync(join(dir, 'CHANGELOG.md'), '## [Unreleased]\n');
  assert.throws(() => sources(dir), /Missing released/);
});

test('preserves CRLF and unmarked text in nested documents', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'docs/nested'));
  const path = join(dir, 'docs/nested/example.md');
  writeFileSync(path, 'Historical v0.1.0\r\n<!-- fresh:begin install -->\r\nstale\r\n<!-- fresh:end -->\r\n');
  assert.equal(cli(dir, 'sync').status, 0);
  const result = readFileSync(path, 'utf8');
  assert.ok(result.startsWith('Historical v0.1.0\r\n'));
  assert.equal(result.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(cli(dir, 'check').status, 0);
});

test('repository blocks are in sync', () => assert.deepEqual(plan(root), []));
