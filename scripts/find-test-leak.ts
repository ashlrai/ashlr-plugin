#!/usr/bin/env bun
/**
 * Bisect helper: find which test file causes a target test to fail.
 * Usage: bun run scripts/find-test-leak.ts <target-test-file>
 *
 * Runs a modified version of the target test (with skip removed) after each
 * sibling test file, reports which combination causes failure.
 */

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { existsSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import { isAbsolute, dirname, join, relative, resolve, sep } from "path";

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
/** Drop the Win32 `\\?\` prefix and resolve 8.3 short names to the long path. */
function samePath(p: string): string {
  const unwrapped = p.startsWith("\\\\?\\") ? p.slice(4) : p;
  const resolved = resolve(unwrapped);
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

export function resolveTargetTestFile(arg: string | undefined, testsRoot = testsDir): string | null {
  if (!arg || CONTROL_CHARS.test(arg)) return null;
  const root = samePath(testsRoot);
  const target = resolve(arg.startsWith("\\\\?\\") ? arg.slice(4) : arg);
  const rel = relative(root, samePath(target));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel)) return null;
  if (!target.endsWith(".test.ts")) return null;
  return target;
}

function main(): number {
  // Bun on Windows does not keep import.meta.dir or argv slots stable for a
  // copied script: the module path can stay on the original repo, and the
  // target path is not always argv[2]. Find the script and the *.test.ts
  // argument we were actually given.
  const asPath = (arg: string) => arg.startsWith("file://") ? fileURLToPath(arg) : arg;
  const scriptArg = process.argv.map(asPath).find((arg) => /(?:^|[\\/])find-test-leak\.ts$/i.test(arg));
  const executed = scriptArg ? dirname(resolve(scriptArg)) : import.meta.dir;
  const testsRoot = join(executed, "../__tests__");
  const target = process.argv.slice(1).map(asPath).find((arg) => arg !== scriptArg && /(?:^|[\\/])[^\\/]+\.test\.ts$/i.test(arg));
  const targetPath = resolveTargetTestFile(target, testsRoot);
  if (!targetPath) {
    console.error("Usage: bun run scripts/find-test-leak.ts <target-test-file>");
    console.error("  (target must be a *.test.ts file inside __tests__/)");
    console.error(JSON.stringify({ argv: process.argv, testsRoot, target }));
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
  const siblings = readdirSync(testsRoot)
    .filter(f => f.endsWith(".test.ts") && join(testsRoot, f) !== targetPath && join(testsRoot, f) !== unskippedPath)
    .sort()
    .map(f => join(testsRoot, f));

  console.log(`Target: ${targetPath}`);
  console.log(`Unskipped copy: ${unskippedPath}`);
  console.log(`Testing ${siblings.length} siblings...\n`);

  let found: string[] = [];

  for (const sibling of siblings) {
    process.stdout.write(`  ${relative(testsRoot, sibling)} ... `);
    const result = spawnSync(
      process.execPath,
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
    for (const f of found) console.log(" ", relative(testsRoot, f));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
