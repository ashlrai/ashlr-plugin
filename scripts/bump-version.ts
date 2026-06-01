#!/usr/bin/env bun
// bump-version.ts — single source of truth for the plugin manifest version.
//
// Writes <new-version> into the three public-facing manifests that must always
// agree (package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json).
// Does NOT touch git, tags, or the CHANGELOG — release sequencing stays human/CI
// controlled. Sub-workspaces (server/, site/, vscode/) version independently and
// are intentionally excluded.
//
// Usage: bun run scripts/bump-version.ts <version>
//   e.g. bun run scripts/bump-version.ts 1.34.0
//
// See check-version-sync.ts for the CI gate that enforces agreement.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// SemVer with optional pre-release/build metadata (e.g. 1.34.0, 1.34.0-rc.1).
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Read a JSON manifest, preserving 2-space indentation on write. */
function readJson(rel: string): { path: string; data: any } {
  const path = join(ROOT, rel);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function bumpVersion(version: string): string[] {
  if (!SEMVER.test(version)) {
    throw new Error(`invalid SemVer: "${version}" (expected e.g. 1.34.0)`);
  }

  const touched: string[] = [];

  const pkg = readJson("package.json");
  pkg.data.version = version;
  writeJson(pkg.path, pkg.data);
  touched.push("package.json");

  const plugin = readJson(".claude-plugin/plugin.json");
  plugin.data.version = version;
  writeJson(plugin.path, plugin.data);
  touched.push(".claude-plugin/plugin.json");

  const mkt = readJson(".claude-plugin/marketplace.json");
  if (mkt.data.metadata) mkt.data.metadata.version = version;
  if (Array.isArray(mkt.data.plugins)) {
    for (const p of mkt.data.plugins) p.version = version;
  }
  writeJson(mkt.path, mkt.data);
  touched.push(".claude-plugin/marketplace.json");

  return touched;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun run scripts/bump-version.ts <version>");
    process.exit(1);
  }
  try {
    const touched = bumpVersion(version);
    console.log(`✓ bumped to ${version}:`);
    for (const f of touched) console.log(`  - ${f}`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
