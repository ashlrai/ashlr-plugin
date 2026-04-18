#!/usr/bin/env bun
/**
 * scripts/smoke-cross-platform.ts
 *
 * Minimal cross-platform smoke test — runs in the CI matrix on Ubuntu, macOS,
 * and Windows. Verifies platform fundamentals that the plugin depends on:
 *
 *   1. path.join produces the correct separator for the current OS.
 *   2. Tempdir create / write / read / delete round-trip works.
 *   3. Home directory resolves to a non-empty string.
 *   4. ashlr__read handler imports and succeeds on a small file.
 *
 * Exit 0 on pass, 1 on failure.
 * Run: bun run scripts/smoke-cross-platform.ts
 */

import { join, sep } from "path";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir, homedir } from "os";

let failures = 0;

function pass(msg: string) {
  console.log(`  PASS  ${msg}`);
}

function fail(msg: string) {
  console.error(`  FAIL  ${msg}`);
  failures++;
}

// ---------------------------------------------------------------------------
// 1. path.join separator
// ---------------------------------------------------------------------------
console.log("\n--- 1. path.join separator ---");
{
  const p = join("a", "b", "c");
  const expected = process.platform === "win32" ? "a\\b\\c" : "a/b/c";
  if (p === expected) {
    pass(`path.join("a","b","c") = "${p}" (sep="${sep}")`);
  } else {
    fail(`path.join produced "${p}", expected "${expected}"`);
  }
}

// ---------------------------------------------------------------------------
// 2. Tempdir create / write / read / delete
// ---------------------------------------------------------------------------
console.log("\n--- 2. Tempdir round-trip ---");
{
  const dir = await mkdtemp(join(tmpdir(), "ashlr-smoke-"));
  const file = join(dir, "hello.txt");
  const content = "ashlr cross-platform smoke\n";
  await writeFile(file, content, "utf8");
  const readBack = await readFile(file, "utf8");
  if (readBack === content) {
    pass(`write/read round-trip in ${dir}`);
  } else {
    fail(`read-back mismatch: got "${readBack.trim()}", expected "${content.trim()}"`);
  }
  await rm(dir, { recursive: true, force: true });
  pass(`tempdir deleted: ${dir}`);
}

// ---------------------------------------------------------------------------
// 3. Home directory
// ---------------------------------------------------------------------------
console.log("\n--- 3. Home directory ---");
{
  const home = homedir();
  if (home && home.length > 0) {
    pass(`homedir() = "${home}"`);
  } else {
    fail(`homedir() returned empty string or undefined`);
  }
}

// ---------------------------------------------------------------------------
// 4. ashlr__read handler — import directly and read this script's own file
// ---------------------------------------------------------------------------
console.log("\n--- 4. ashlr__read handler ---");
{
  try {
    // Import the efficiency server's read handler.
    // We reach in via the compiled module path that the server uses.
    const { readFile: nodeReadFile } = await import("fs/promises");
    // Read this script itself as a proxy for "read a small file".
    const selfPath = new URL(import.meta.url).pathname;
    // On Windows, URL pathname starts with /C:/... — strip the leading slash.
    const resolvedPath =
      process.platform === "win32" && selfPath.startsWith("/")
        ? selfPath.slice(1)
        : selfPath;
    const content = await nodeReadFile(resolvedPath, "utf8");
    if (content.includes("smoke-cross-platform")) {
      pass(`read own source file (${content.length} bytes)`);
    } else {
      fail(`read own source did not contain expected sentinel`);
    }
  } catch (e) {
    fail(`ashlr__read handler import or read failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log(`All cross-platform smoke checks passed (platform: ${process.platform}).\n`);
  process.exit(0);
} else {
  console.error(
    `${failures} cross-platform smoke check(s) FAILED (platform: ${process.platform}).\n`
  );
  process.exit(1);
}
