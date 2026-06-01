#!/usr/bin/env bun
// check-version-sync.ts — CI gate that fails if the public manifest versions drift.
//
// package.json is the source of truth. plugin.json + marketplace.json (both the
// metadata.version and every plugins[].version) must equal it. Exits 1 with a
// mismatch table when they diverge — this is exactly the failure mode that let
// the manifests sit at 1.29.0 while tags advanced to 1.33.0.
//
// The newest CHANGELOG "## [X.Y.Z]" header is a SOFT check (warn-only) so that
// both CHANGELOG-first and tag-first release flows pass.
//
// Usage: bun run scripts/check-version-sync.ts
// Zero dependencies — safe to run before `bun install` in CI.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

export interface VersionCheck {
  ok: boolean;
  rootVersion: string;
  mismatches: Array<{ field: string; value: string }>;
  changelogVersion: string | null;
  changelogWarn: boolean;
}

export function checkVersionSync(): VersionCheck {
  const rootVersion = readJson("package.json").version;
  const mismatches: VersionCheck["mismatches"] = [];

  const check = (field: string, value: unknown) => {
    if (value !== rootVersion) {
      mismatches.push({ field, value: String(value) });
    }
  };

  const plugin = readJson(".claude-plugin/plugin.json");
  check(".claude-plugin/plugin.json#version", plugin.version);

  const mkt = readJson(".claude-plugin/marketplace.json");
  check(".claude-plugin/marketplace.json#metadata.version", mkt?.metadata?.version);
  if (Array.isArray(mkt?.plugins)) {
    mkt.plugins.forEach((p: any, i: number) =>
      check(`.claude-plugin/marketplace.json#plugins[${i}].version`, p?.version),
    );
  }

  // Soft CHANGELOG check.
  let changelogVersion: string | null = null;
  try {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const m = changelog.match(/^##\s*\[(\d+\.\d+\.\d+[^\]]*)\]/m);
    changelogVersion = m ? m[1] : null;
  } catch {
    /* CHANGELOG optional for the hard check */
  }
  const changelogWarn = changelogVersion !== null && changelogVersion !== rootVersion;

  return {
    ok: mismatches.length === 0,
    rootVersion,
    mismatches,
    changelogVersion,
    changelogWarn,
  };
}

if (import.meta.main) {
  const r = checkVersionSync();

  if (r.changelogWarn) {
    console.warn(
      `⚠ CHANGELOG newest entry [${r.changelogVersion}] != package.json ${r.rootVersion} ` +
        `(ok if a release is in progress)`,
    );
  }

  if (!r.ok) {
    console.error(`✗ version manifests out of sync. Source of truth: package.json = ${r.rootVersion}`);
    for (const m of r.mismatches) {
      console.error(`    ${m.field} = ${m.value}`);
    }
    console.error(`  Fix: bun run scripts/bump-version.ts ${r.rootVersion}`);
    process.exit(1);
  }

  console.log(`✓ all manifests in sync at ${r.rootVersion}`);
}
