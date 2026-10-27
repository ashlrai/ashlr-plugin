#!/usr/bin/env bun
/**
 * Usage: bun scripts/affected-tests.ts <base>
 * Prints a JSON array of repo-relative Bun test targets, or the literal ALL.
 * Compare committed changes at base...HEAD; staged/untracked files are excluded.
 * Run from any directory within the repository. Resolve targets at its root.
 * Source changes select whole packages because tests use dynamic imports,
 * subprocesses and file reads. Integration tests consume both runtime packages;
 * the backend also invokes root scripts for genome builds.
 * ALL means run the normal full checks, including packages without Bun tests.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type AffectedTests = "ALL" | string[];

const suites = ["./__tests__", "./server/tests", "./integration/tests"] as const;

function packageTargets(path: string): string[] | undefined {
  if (path.startsWith("server/")) return [suites[1], suites[2]];
  if (path.startsWith("integration/")) return [suites[2]];
  if (/^(servers|scripts|hooks|ports|commands|skills|agents|__tests__)\//.test(path)) {
    return [...suites];
  }
  return undefined;
}

function isConfig(path: string): boolean {
  const name = basename(path);
  return /(^|\/)[.]/.test(path)
    || /(^|[.-])(lock|lockb|config)([.-]|$)/i.test(name)
    || /^(package(?:-lock)?\.json|npm-shrinkwrap\.json|Cargo\.(toml|lock)|bunfig\.toml|tsconfig.*\.json|jsconfig.*\.json|Dockerfile|Makefile)$/.test(name)
    || /\.(json|jsonc|ya?ml|toml|ini)$/.test(name);
}

/** Parse `git diff --name-status -z --no-renames` without splitting filenames. */
export function affectedTests(diff: string): AffectedTests {
  if (!diff) return [];
  const fields = diff.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) {
    throw new Error("Expected NUL-delimited git name-status output");
  }
  const targets = new Set<string>();
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!;
    const path = fields[i + 1]!;
    if (!/^[AMDTUXB]$/.test(status) || !path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("Invalid git name-status record");
    }
    if (isConfig(path)) return "ALL";
    const testInput = /^(?:__tests__|server\/tests|integration\/tests)\//.test(path);
    // Documentation fixtures are test inputs, even when named README.md.
    // Markdown under commands/skills/agents is executable product input.
    const runtimeMarkdown = /^(commands|skills|agents)\//.test(path);
    if (!testInput && !runtimeMarkdown && ((/(^|\/)docs\//.test(path) && /\.(md|mdx|rst|txt)$/i.test(path))
      || /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE)(\.(md|mdx|rst|txt))?$/i.test(path)
      || (!path.includes("/") && /\.(md|mdx|rst|txt)$/i.test(path)))) continue;
    const packages = packageTargets(path);
    if (!packages) return "ALL";
    const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
      && testInput;
    if (testFile && status !== "D") targets.add(`./${path}`);
    else for (const target of packages) targets.add(target);
  }
  // A selected package already includes its individual test files.
  return [...targets].filter(target => ![...targets].some(parent => target.startsWith(`${parent}/`))).sort();
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
      throw new Error("Usage: bun scripts/affected-tests.ts <base>");
    }
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    // Resolve first so option-like refs and revision expressions cannot change diff flags.
    const base = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${args[0]}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const diff = execFileSync("git", ["diff", "--name-status", "-z", "--no-renames", `${base}...HEAD`, "--"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const result = affectedTests(diff);
    console.log(result === "ALL" ? result : JSON.stringify(result));
  } catch {
    // Never turn missing history, invalid arguments or Git failures into a skip.
    console.error("affected-tests: unable to select tests; supply a valid base with shared history. Usage: bun scripts/affected-tests.ts <base>");
    process.exitCode = 1;
  }
}
