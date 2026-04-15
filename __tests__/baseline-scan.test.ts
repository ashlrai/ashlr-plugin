/**
 * Tests for scripts/baseline-scan.ts
 *
 * Covers:
 *   - Empty dir → graceful
 *   - Synthetic project → counts + entry + tests + genome
 *   - Cache hit / cache invalidation
 *   - --json output validity (tested via formatBaseline + scan API)
 *   - > 5,000 file truncation
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  cachePathFor,
  detectGenome,
  detectTests,
  extOf,
  FILE_CAP,
  formatBaseline,
  scan,
  tallyExtensions,
} from "../scripts/baseline-scan";

let projectDir: string;
let homeDir: string;

function write(rel: string, body = ""): void {
  const full = join(projectDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ashlr-baseline-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "ashlr-baseline-home-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("extOf", () => {
  test("returns lowercase extension", () => {
    expect(extOf("foo/bar.TS")).toBe(".ts");
    expect(extOf("foo/Makefile")).toBe("(none)");
    expect(extOf(".gitignore")).toBe("(none)");
  });
});

describe("tallyExtensions", () => {
  test("groups and tops correctly", () => {
    const files = [
      "a.ts",
      "b.ts",
      "c.ts",
      "d.tsx",
      "e.tsx",
      "f.md",
      "g.json",
      "h.css",
      "i.yml",
      "j.txt",
      "k.txt",
    ];
    const r = tallyExtensions(files, 4);
    expect(r.top.length).toBe(4);
    expect(r.top[0]).toEqual({ ext: ".ts", count: 3 });
    expect(r.other).toBeGreaterThan(0);
  });
});

describe("scan: empty dir", () => {
  test("graceful no-files output", () => {
    const b = scan({ dir: projectDir, home: homeDir, noCache: true });
    expect(b.fileCount).toBe(0);
    expect(b.truncated).toBe(false);
    expect(b.entryPoints).toEqual([]);
    expect(b.largestFiles).toEqual([]);
    expect(b.tests.count).toBe(0);
    expect(b.genome.present).toBe(false);
    const out = formatBaseline(b);
    expect(out).toContain("project: 0 files");
    expect(out).toContain("entry:   (none detected)");
  });
});

describe("scan: synthetic project", () => {
  test("counts files, detects entry/tests/genome", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "synthetic",
        type: "module",
        bin: { mycli: "src/cli.ts" },
        scripts: { test: "bun test" },
      }),
    );
    write("src/cli.ts", "console.log('hi');\n".repeat(50));
    write("src/index.ts", "export {};\n");
    write("src/util.ts", "// util\n".repeat(10));
    write("README.md", "# hi\n");
    write("__tests__/a.test.ts", "import {test} from 'bun:test';\n");
    write("__tests__/b.test.ts", "import {test} from 'bun:test';\n");
    write(".ashlrcode/genome/architecture.md", "# arch\n");
    write(".ashlrcode/genome/conventions.md", "# conv\n");

    const b = scan({ dir: projectDir, home: homeDir, noCache: true });
    expect(b.fileCount).toBeGreaterThan(0);
    const tsCount = b.extensions.find((e) => e.ext === ".ts")?.count ?? 0;
    expect(tsCount).toBeGreaterThanOrEqual(5);
    expect(b.entryPoints.some((e) => e.includes("src/cli.ts"))).toBe(true);
    expect(b.tests.count).toBe(2);
    expect(b.tests.locations).toContain("__tests__/");
    expect(b.tests.framework).toBe("bun:test");
    expect(b.genome.present).toBe(true);
    expect(b.genome.sections).toBe(2);
    expect(b.largestFiles.length).toBeGreaterThan(0);
    expect(b.largestFiles[0].path).toBe("src/cli.ts");
  });
});

describe("detectGenome", () => {
  test("absent when missing", () => {
    expect(detectGenome(projectDir)).toEqual({ present: false, sections: 0 });
  });
  test("counts sections", () => {
    write(".ashlrcode/genome/a.md", "");
    write(".ashlrcode/genome/b.md", "");
    write(".ashlrcode/genome/c.md", "");
    expect(detectGenome(projectDir)).toEqual({ present: true, sections: 3 });
  });
});

describe("detectTests", () => {
  test("recognizes multiple patterns", () => {
    const files = [
      "__tests__/x.test.ts",
      "src/foo.spec.ts",
      "test/bar.js",
      "tests/zed.py",
      "src/test_thing.py",
    ];
    const r = detectTests(files, projectDir);
    expect(r.count).toBeGreaterThanOrEqual(4);
  });
});

describe("scan: git repo", () => {
  test("branch + uncommitted detection", () => {
    // Init git repo
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: projectDir, encoding: "utf-8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    write("a.txt", "hi");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "init"]);
    write("b.txt", "uncommitted");

    const b = scan({ dir: projectDir, home: homeDir, noCache: true });
    expect(b.git.isRepo).toBe(true);
    expect(b.git.branch).toBe("main");
    expect((b.git.uncommitted ?? 0)).toBeGreaterThanOrEqual(1);
    expect(b.git.lastSubject).toBe("init");
  });
});

describe("scan: cache", () => {
  test("second invocation reads cache", () => {
    write("a.ts", "x\n");
    const first = scan({ dir: projectDir, home: homeDir });
    expect(first.cache.cached).toBe(false);
    const cachePath = cachePathFor(projectDir, homeDir);
    expect(existsSync(cachePath)).toBe(true);
    const second = scan({ dir: projectDir, home: homeDir });
    expect(second.cache.cached).toBe(true);
    expect(second.fileCount).toBe(first.fileCount);
  });

  test("cache invalidation when newest mtime moves", () => {
    write("package.json", "{}");
    const first = scan({ dir: projectDir, home: homeDir });
    expect(first.cache.cached).toBe(false);

    // Bump package.json mtime well past the cached newestMtime.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(join(projectDir, "package.json"), future, future);

    const second = scan({ dir: projectDir, home: homeDir });
    expect(second.cache.cached).toBe(false);
  });

  test("--no-cache bypasses cache", () => {
    write("a.ts", "x");
    scan({ dir: projectDir, home: homeDir });
    const second = scan({ dir: projectDir, home: homeDir, noCache: true });
    expect(second.cache.cached).toBe(false);
  });
});

describe("scan: JSON shape", () => {
  test("baseline serializes to valid JSON with required fields", () => {
    write("a.ts", "x\n");
    const b = scan({ dir: projectDir, home: homeDir, noCache: true });
    const json = JSON.stringify(b);
    const parsed = JSON.parse(json);
    for (
      const k of [
        "generatedAt",
        "durationMs",
        "dir",
        "fileCount",
        "truncated",
        "extensions",
        "topExtensions",
        "otherCount",
        "entryPoints",
        "largestFiles",
        "tests",
        "genome",
        "git",
        "runtime",
        "newestMtime",
        "cache",
      ]
    ) {
      expect(parsed).toHaveProperty(k);
    }
  });
});

describe("scan: truncation at FILE_CAP", () => {
  test("> cap files → truncated: true", () => {
    // Use a tiny cap to keep the test fast.
    const cap = 50;
    for (let i = 0; i < cap + 25; i++) {
      write(`gen/f${i}.ts`, "x\n");
    }
    const b = scan({ dir: projectDir, home: homeDir, noCache: true, cap });
    expect(b.truncated).toBe(true);
    expect(b.fileCount).toBe(cap);
  });

  test("FILE_CAP is 5000", () => {
    expect(FILE_CAP).toBe(5000);
  });
});

describe("formatBaseline", () => {
  test("renders all expected lines", () => {
    write("package.json", JSON.stringify({ bin: "src/cli.ts" }));
    write("src/cli.ts", "x\n");
    write("__tests__/a.test.ts", "x\n");
    const b = scan({ dir: projectDir, home: homeDir, noCache: true });
    const out = formatBaseline(b);
    expect(out).toContain("[ashlr baseline");
    expect(out).toContain("project:");
    expect(out).toContain("entry:");
    expect(out).toContain("tests:");
    expect(out).toContain("runtime:");
    expect(out).toContain("git:");
  });
});
