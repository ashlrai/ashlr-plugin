#!/usr/bin/env bun
/**
 * Bisect helper: find which test file causes a target test to fail.
 * Usage: bun run scripts/find-test-leak.ts <target-test-file>
 *
 * Runs a modified version of the target test (with skip removed) after each
 * sibling test file, reports which combination causes failure.
 */

import { spawnSync } from "child_process";
import { readdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";

const testsDir = join(import.meta.dir, "../__tests__");

// Control characters can never appear in a real path arg — anything
// containing one is malformed input, not a test file.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Resolve a caller-supplied argument to a *.test.ts file inside __tests__/.
 * The tool bisects sibling tests, so a target anywhere else (or one that
 * isn't a test file at all) is a usage error — and keeps argv from becoming
 * an arbitrary file-read primitive.
 */
export function resolveTargetTestFile(arg: string | undefined): string | null {
  if (!arg || CONTROL_CHARS.test(arg)) return null;
  const root = resolve(testsDir);
  const target = resolve(arg);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (!rel.endsWith(".test.ts")) return null;
  return target;
}

function main(): number {
  const target = process.argv[2];
  const targetPath = resolveTargetTestFile(target);
  if (!targetPath) {
    console.error("Usage: bun run scripts/find-test-leak.ts <target-test-file>");
    console.error("  (target must be a *.test.ts file inside __tests__/)");
    return 1;
  }

  // Build unskipped version of target
  const originalContent = readFileSync(targetPath, "utf-8");
  const unskippedContent = originalContent.replace(
    /test\.skip\(/g,
    "test(",
  );
  const unskippedPath = targetPath.replace(/\.test\.ts$/, "-UNSKIPPED.test.ts");
  writeFileSync(unskippedPath, unskippedContent);

  // Get all sibling test files (flat only, skip integration/quality subdirs)
  const siblings = readdirSync(testsDir)
    .filter(f => f.endsWith(".test.ts") && join(testsDir, f) !== targetPath && join(testsDir, f) !== unskippedPath)
    .sort()
    .map(f => join(testsDir, f));

  console.log(`Target: ${targetPath}`);
  console.log(`Unskipped copy: ${unskippedPath}`);
  console.log(`Testing ${siblings.length} siblings...\n`);

  let found: string[] = [];

  for (const sibling of siblings) {
    process.stdout.write(`  ${relative(testsDir, sibling)} ... `);
    const result = spawnSync(
      "bun",
      ["test", sibling, unskippedPath],
      { encoding: "utf-8", timeout: 60_000, cwd: join(import.meta.dir, "..") }
    );
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    // Only count as a leaker if there is an actual test failure (not a "0 tests matched" exit).
    if (result.status !== 0 && out.includes(" fail")) {
      console.log("FAIL <-- LEAKER");
      found.push(sibling);
    } else {
      console.log("pass");
    }
  }

  unlinkSync(unskippedPath);

  console.log("\n--- Result ---");
  if (found.length === 0) {
    console.log("No single-file leaker found. The leak may require multiple files.");
  } else {
    console.log("Leaking files:");
    for (const f of found) console.log(" ", relative(testsDir, f));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
