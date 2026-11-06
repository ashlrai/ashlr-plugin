import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const required = {
  'README.md': ['version-badge', 'install'],
  'docs/README.md': ['version-table'],
  'examples/README.md': ['example-pin'],
  'FAQ.md': ['install'],
  'CHANGELOG.md': ['release-summary'],
};
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;

export function sources(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!semver.test(pkg.version)) throw new Error('Invalid package.json version');
  for (const name of ['version:check', 'gen:tool-catalog']) {
    if (typeof pkg.scripts?.[name] !== 'string' || !pkg.scripts[name].trim()) {
      throw new Error(`Missing package.json script: ${name}`);
    }
  }
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  // Skip Unreleased and prereleases; never derive the release from generated text.
  const release = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})(?=\r?$)/m);
  if (!release) throw new Error('Missing released CHANGELOG.md section');
  return { version: pkg.version, released: release[1], date: release[2] };
}

export function render(name, { version, released, date }) {
  switch (name) {
    case 'version-badge':
      return `[![Version](https://img.shields.io/badge/version-${encodeURIComponent(version).replaceAll('-', '%2D')}-blue)](https://www.npmjs.com/package/ashlr-plugin/v/${version})`;
    case 'install':
      return `\`\`\`bash\nnpm install -g ashlr-plugin@${version}\n\`\`\``;
    case 'version-table':
      return `| Source | Version |\n| --- | --- |\n| package.json | ${version} |\n| Latest released changelog (${date}) | ${released} |\n\nValidate manifests with \`bun run version:check\`; regenerate the tool catalog with \`bun run gen:tool-catalog\`.`;
    case 'example-pin':
      return `\`\`\`json\n{ "devDependencies": { "ashlr-plugin": "${version}" } }\n\`\`\``;
    case 'release-summary':
      return `Latest documented release: [${released}] (${date}). Package version: ${version}.`;
    default: throw new Error(`Unknown freshness block: ${name}`);
  }
}

function documents(root) {
  const files = ['README.md', 'FAQ.md', 'CHANGELOG.md'];
  function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(md|mdx|html)$/.test(entry.name)) files.push(path);
    }
  }
  walk('docs');
  walk('examples');
  return files.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

export function plan(root) {
  const data = sources(root);
  return documents(root).map(path => {
    const before = readFileSync(join(root, path), 'utf8');
    const newline = before.includes('\r\n') ? '\r\n' : '\n';
    const seen = new Set();
    const after = before.replace(/<!-- fresh:begin ([a-z-]+) -->\r?\n([\s\S]*?)<!-- fresh:end -->/g, (block, name, body) => {
      if (body.includes('<!-- fresh:')) throw new Error(`${path}: nested freshness marker`);
      if (seen.has(name)) throw new Error(`${path}: duplicate freshness block ${name}`);
      seen.add(name);
      return `<!-- fresh:begin ${name} -->${newline}${render(name, data).replaceAll('\n', newline)}${newline}<!-- fresh:end -->`;
    });
    const stripped = after.replace(/<!-- fresh:begin [a-z-]+ -->\r?\n[\s\S]*?<!-- fresh:end -->/g, '');
    if (stripped.includes('<!-- fresh:')) throw new Error(`${path}: malformed freshness marker`);
    for (const name of required[path] ?? []) {
      if (!seen.has(name)) throw new Error(`${path}: missing freshness block ${name}`);
    }
    return { path, before, after };
  }).filter(file => file.before !== file.after);
}

export function run(root, sync = false) {
  // Validate every file before writing any changes.
  const changes = plan(root);
  for (const file of changes) {
    if (sync) writeFileSync(join(root, file.path), file.after);
    console.log(`${sync ? 'Updated' : 'Stale'}: ${file.path}`);
  }
  if (!sync && changes.length) console.error('Run bun run fresh:sync to regenerate documentation.');
  return sync || changes.length === 0 ? 0 : 1;
}
