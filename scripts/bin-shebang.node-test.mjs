import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

test('package.json bin has at least 2 entries', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, '..', 'package.json'), 'utf8'));
  const bins = pkg.bin;
  ok(bins, 'package.json must have a "bin" field');
  const count = typeof bins === 'object' ? Object.keys(bins).length : 0;
  ok(count >= 2, `bin must have at least 2 entries (found ${count})`);
});

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, '..', 'package.json'), 'utf8'));
const bins = pkg.bin;
const binPaths = typeof bins === 'object' ? Object.values(bins) : [bins];

for (const relPath of binPaths) {
  test(`bin file ${relPath} exists from repo root`, () => {
    const absPath = join(REPO_ROOT, '..', relPath);
    ok(existsSync(absPath), `expected ${relPath} to exist at ${absPath}`);
  });

  test(`bin file ${relPath} has shebang #!/usr/bin/env node`, () => {
    const absPath = join(REPO_ROOT, '..', relPath);
    const firstLine = readFileSync(absPath, 'utf8').split('\n')[0].trim();
    deepStrictEqual(firstLine, '#!/usr/bin/env node');
  });
}
