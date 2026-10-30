/**
 * sonar-order-q9.test.ts — regression coverage for the Q9 Sonar sweep (a recut
 * of the stuck sonar-order-q8 PR #381 onto current main, plus the follow-up
 * findings it left behind):
 *
 *   - S2871 ("Array.prototype.sort() should use a compare function"): every
 *     .sort() in the touched files now carries an explicit code-unit
 *     comparator — the same ordering the default sort produced, but
 *     deterministic and locale-independent. A static guard keeps every one
 *     of the eleven files free of comparator-less sort calls, and the
 *     behavioral tests below pin the ordering contracts that the sorts serve.
 *
 *   - S5443 ("publicly writable directories are security-sensitive"): no
 *     predictable paths under a shared temp root. server genome builds and
 *     delta rebuilds run inside private mkdtemp (0700) work dirs, and the
 *     orchestrator bench's graph scope is a repo-relative label rather than
 *     a /tmp path (the scope string is never touched on disk — it's a
 *     validated metadata field). The mkdtemp call itself lives inside the
 *     try block so every failure path reaches the rm in finally.
 *
 *   - S1751 ("loops must not execute at most once"): report-crash's promptYes
 *     no longer wraps a single read in a for-await loop — it pulls one chunk
 *     off the stdin async iterator and releases the stream in finally.
 *
 *   - S5868 ("unicode grapheme clusters in regex character classes"): the
 *     package-install summarizer's [✨🚀] class now compiles with the "u"
 *     flag, so 🚀 matches as one code point instead of splitting into
 *     surrogate halves that could match a lone surrogate.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

import { detectTests, type Baseline } from "../scripts/baseline-scan";
import { renderArchitectureMd } from "../scripts/genome-init";
import { run as runReportCrash } from "../scripts/report-crash";
import { buildReport } from "../scripts/session-log-report";
import { summarizeGitStatus, summarizePackageInstall } from "../servers/_bash-summarizers-registry";
import { applyRangeEdits, planExtractFunction } from "../servers/_ast-refactor";
import { parseFile } from "../servers/_ast-helpers";
import { buildProduct, generatedFiles } from "../site/scripts/freshness";

const REPO = resolve(import.meta.dir, "..");

/** Deterministic code-unit comparator — the same shape the fixes apply. */
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedCopy = (xs: string[]) => [...xs].sort(codeUnit);

const S2871_FILES = [
  "scripts/baseline-scan.ts",
  "scripts/genome-init.ts",
  "scripts/report-crash.ts",
  "scripts/session-log-report.ts",
  "server/src/db/public-stats.ts",
  "servers/_ast-refactor/extract-function.ts",
  "servers/_bash-summarizers-registry.ts",
  "servers/_genome-search.ts",
  "site/app/admin/overview/page.tsx",
  "site/scripts/freshness.ts",
  "vscode/src/stats-reader.ts",
];

const S5443_FILES = [
  "scripts/bench-orchestrate.ts",
  "server/src/services/genome-build.ts",
];

describe("S2871 — no comparator-less .sort() calls remain", () => {
  for (const file of S2871_FILES) {
    test(`${file} sorts with an explicit comparator`, () => {
      const src = readFileSync(join(REPO, file), "utf8");
      expect(src.match(/\.sort\(\s*\)/g)).toBeNull();
    });
  }
});

describe("S5443 — no predictable paths inside publicly writable dirs", () => {
  for (const file of S5443_FILES) {
    test(`${file} contains no /tmp path literal`, () => {
      const src = readFileSync(join(REPO, file), "utf8");
      expect(src.match(/["'`]\/tmp\b/)).toBeNull();
    });
  }

  test("genome-build creates mkdtemp work dirs inside try and removes them in finally", () => {
    const src = readFileSync(join(REPO, "server/src/services/genome-build.ts"), "utf8");
    expect(src).toContain('workDir = await mkdtemp(join(tmpdir(), "ashlr-build-"))');
    expect(src).toContain('workDir = await mkdtemp(join(tmpdir(), "ashlr-delta-"))');
    // Both the initial build and the delta rebuild must clean the work root,
    // not just the clone dir (the askpass helper lives beside the clone).
    expect(src.match(/rm\(workDir/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The askpass staging root is created owner-only when it has to be made.
    expect(src).toContain("mkdir(workRoot, { recursive: true, mode: 0o700 })");

    // Structural check per function: `let workDir` is declared before the try,
    // mkdtemp is the first statement inside the try, and rm(workDir) happens
    // in the finally — so a throw between declaration and assignment can't
    // leak a directory and a throw after assignment can't skip cleanup.
    for (const [sig, endSig] of [
      ["async function runBuildInBackground", "export async function rebuildGenomeDelta"],
      ["export async function rebuildGenomeDelta", undefined],
    ] as const) {
      const start = src.indexOf(sig);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = endSig ? src.slice(start, src.indexOf(endSig)) : src.slice(start);
      const decl = body.indexOf("let workDir");
      const mkd = body.indexOf("mkdtemp(");
      expect(decl).toBeGreaterThanOrEqual(0);
      expect(mkd).toBeGreaterThan(decl);
      const tryBefore = body.lastIndexOf("try {", mkd);
      expect(tryBefore).toBeGreaterThan(decl);
      // mkdtemp is the first statement inside the try.
      expect(body.slice(tryBefore + "try {".length, mkd).trim()).toBe("workDir = await");
      const fin = body.lastIndexOf("finally");
      const rm = body.lastIndexOf("rm(workDir");
      expect(rm).toBeGreaterThan(fin);
      expect(fin).toBeGreaterThan(mkd);
    }
  });

  test("bench graph scope is a repo-relative label, not a shared-tmp path", async () => {
    const { SHAPES } = await import("../scripts/bench-orchestrate");
    for (const shape of SHAPES) {
      const graph = shape.build();
      expect(isAbsolute(graph.scope)).toBe(false);
      expect(graph.scope.startsWith(tmpdir())).toBe(false);
    }
  });
});

describe("S1751 — promptYes reads one stdin chunk without a one-shot loop", () => {
  const crashLine = JSON.stringify({ ts: new Date().toISOString(), tool: "t", message: "boom", args: "{}" });

  async function runWithStdin(input: string | null): Promise<{ code: number; errText: string }> {
    const home = mkdtempSync(join(tmpdir(), "sonar-q9-prompt-"));
    const dump = join(home, "dump.jsonl");
    writeFileSync(dump, `${crashLine}\n`);
    const errChunks: string[] = [];
    const realStdin = process.stdin;
    const realErrWrite = process.stderr.write;
    const origHome = process.env["HOME"];
    // A fresh Readable per invocation — Readable.from([]) yields a stream
    // that ends immediately (done on first read).
    const fake = Readable.from(input === null ? [] : [input]);
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    process.stderr.write = ((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.env["HOME"] = home;
    try {
      // --endpoint "" short-circuits after the prompt (returns 3) so a "yes"
      // never touches the network; a "no"/EOF returns 2 earlier.
      const code = await runReportCrash(["--dump", dump, "--endpoint", ""]);
      return { code, errText: errChunks.join("") };
    } finally {
      Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
      process.stderr.write = realErrWrite;
      if (origHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("an affirmative first chunk proceeds past the prompt", async () => {
    const { code, errText } = await runWithStdin("y\n");
    expect(errText).toContain("[Y/n]");
    expect(code).toBe(3); // past the prompt, stopped at the empty endpoint
    expect(errText).toContain("endpoint is empty");
  });

  test("a negative first chunk declines with exit 2", async () => {
    const { code, errText } = await runWithStdin("n\n");
    expect(code).toBe(2);
    expect(errText).toContain("Declined.");
  });

  test("an empty stdin declines instead of hanging", async () => {
    const { code, errText } = await runWithStdin(null);
    expect(code).toBe(2);
    expect(errText).toContain("Declined.");
  });
});

describe("S5868 — package-install summarizer handles non-BMP emoji as code points", () => {
  const preamble = "progress noise\n".repeat(30); // past the 200-byte floor

  test("rocket-emoji yarn lines still match", () => {
    const out = summarizePackageInstall(`${preamble}🚀  Done in 1.87s.\n`);
    expect(out).toBe("🚀  Done in 1.87s.");
  });

  test("a lone low surrogate does not satisfy the emoji class", () => {
    // Without the u flag, [✨🚀] decomposes to [✨ \uD83D \uDE80] and this
    // line — which has no emoji, only a stray surrogate — would be kept.
    const out = summarizePackageInstall(`${preamble}\uDE80 Done in 9.99s\n`);
    expect(out).toBeNull();
  });
});

describe("S2871 ordering behavior", () => {
  test("detectTests emits locations in code-unit order", () => {
    const dir = mkdtempSync(join(tmpdir(), "sonar-q9-tests-"));
    try {
      const files = [
        "pkg/x_test.py", // "*_test.py"
        "src/mod.test.ts", // "*.test.ts"
        "tests/test_a.py", // "test/"
        "spec/thing_spec.rb", // "spec/"
      ];
      const { locations } = detectTests(files, dir);
      expect(locations).toEqual(["*.test.ts", "*_test.py", "spec/", "test/"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("summarizeGitStatus buckets in sorted order regardless of input order", () => {
    const out = summarizeGitStatus(" M a.ts\n?? b.ts\nA  c.ts\n M d.ts\n");
    expect(out).toBe("??: 1, A: 1, M: 2");
  });

  test("genome-init architecture tree lists dirs then files, each sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "sonar-q9-arch-"));
    try {
      mkdirSync(join(dir, "zeta"));
      mkdirSync(join(dir, "alpha"));
      writeFileSync(join(dir, "zebra.md"), "x");
      writeFileSync(join(dir, "apple.ts"), "x");
      const baseline: Baseline = {
        generatedAt: "2026-01-01T00:00:00Z",
        durationMs: 0,
        dir,
        fileCount: 0,
        truncated: false,
        extensions: [],
        topExtensions: [],
        otherCount: 0,
        entryPoints: [],
        largestFiles: [],
        tests: { count: 0, locations: [] },
        genome: { present: false, sections: 0 },
        git: { isRepo: false },
        runtime: { name: "Bun", notes: [] },
        newestMtime: 0,
        cache: { cached: false },
      };
      const tree = renderArchitectureMd(baseline)
        .split("\n")
        .filter((l) => l.startsWith("├── "));
      expect(tree).toEqual(["├── alpha/", "├── zeta/", "├── apple.ts", "├── zebra.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session-log fallback rows sort by tool then event:reason", () => {
    const home = mkdtempSync(join(tmpdir(), "sonar-q9-log-"));
    try {
      const logDir = join(home, ".ashlr");
      mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString();
      const recs = [
        { ts, event: "tool_fallback", tool: "zebra", reason: "r1" },
        { ts, event: "tool_fallback", tool: "alpha", reason: "r1" },
        { ts, event: "tool_fallback", tool: "beta", reason: "r9" },
        { ts, event: "tool_escalate", tool: "beta", reason: "r9" },
      ];
      writeFileSync(
        join(logDir, "session-log.jsonl"),
        recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      const report = buildReport({ home });
      const iAlpha = report.indexOf("alpha  tool_fallback:r1");
      const iBetaEsc = report.indexOf("beta  tool_escalate:r9");
      const iBetaFb = report.indexOf("beta  tool_fallback:r9");
      const iZebra = report.indexOf("zebra  tool_fallback:r1");
      for (const i of [iAlpha, iBetaEsc, iBetaFb, iZebra]) {
        expect(i).toBeGreaterThanOrEqual(0);
      }
      expect(iAlpha).toBeLessThan(iBetaEsc);
      expect(iBetaEsc).toBeLessThan(iBetaFb);
      expect(iBetaFb).toBeLessThan(iZebra);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("report-crash --stdout --all emits records newest-first and drops old dumps", async () => {
    const home = mkdtempSync(join(tmpdir(), "sonar-q9-crash-"));
    const crashes = join(home, ".ashlr", "crashes");
    mkdirSync(crashes, { recursive: true });
    const day = (offset: number) =>
      new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const rec = (ts: string, message: string) =>
      JSON.stringify({ ts, tool: "t", message, args: "{}" });
    // Today's dump carries an older record than yesterday's — the per-file
    // name sort and the per-record ts sort must cooperate on output order.
    writeFileSync(join(crashes, `${day(0)}.jsonl`), `${rec(`${day(2)}T01:00:00Z`, "old-today-file")}\n`);
    writeFileSync(join(crashes, `${day(1)}.jsonl`), `${rec(`${day(1)}T12:00:00Z`, "yesterday")}\n`);
    writeFileSync(join(crashes, `${day(30)}.jsonl`), `${rec(`${day(30)}T00:00:00Z`, "too-old")}\n`);

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    const origHome = process.env["HOME"];
    process.env["HOME"] = home;
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code = -1;
    try {
      code = await runReportCrash(["--stdout", "--all"]);
    } finally {
      process.stdout.write = origWrite;
      if (origHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = origHome;
      rmSync(home, { recursive: true, force: true });
    }
    expect(code).toBe(0);
    const records = chunks
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { ts: string; message: string });
    expect(records.map((r) => r.message)).toEqual(["yesterday", "old-today-file"]);
    expect(Date.parse(records[0]!.ts)).toBeGreaterThan(Date.parse(records[1]!.ts));
  });

  test("genome search postings follow the sorted md-file order", async () => {
    const home = mkdtempSync(join(tmpdir(), "sonar-q9-gshome-"));
    const repo = mkdtempSync(join(tmpdir(), "sonar-q9-gsrepo-"));
    const origHome = process.env["HOME"];
    // CACHE_DIR binds HOME at module load — set it before the dynamic import.
    process.env["HOME"] = home;
    try {
      const knowledge = join(repo, ".ashlrcode", "genome", "knowledge");
      mkdirSync(join(knowledge, "mid"), { recursive: true });
      const md = (section: string) => `# t\n\n## ${section}\n\npostgres body\n`;
      writeFileSync(join(knowledge, "zeta.md"), md("zeta section"));
      writeFileSync(join(knowledge, "alpha.md"), md("alpha section"));
      writeFileSync(join(knowledge, "mid", "beta.md"), md("beta section"));

      const { getGenomeSearchIndex } = await import("../servers/_genome-search");
      const files = getGenomeSearchIndex(repo)
        .lookup("postgres")
        .map((r) => r.file);
      expect([...new Set(files)]).toEqual([
        join(knowledge, "alpha.md"),
        join(knowledge, "mid", "beta.md"),
        join(knowledge, "zeta.md"),
      ]);
    } finally {
      if (origHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = origHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("extract-function destructures multiple outputs in sorted order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sonar-q9-extract-"));
    try {
      const src = [
        "function f() {",
        "  let z = 0;",
        "  let a = 0;",
        "  z = 1;",
        "  a = 2;",
        "  console.log(z + a);",
        "}",
        "",
      ].join("\n");
      const path = join(dir, "extract.ts");
      writeFileSync(path, src);
      const parsed = await parseFile(path);
      if (!parsed) throw new Error("parseFile returned null");
      const body = "  z = 1;\n  a = 2;";
      const start = src.indexOf(body);
      const result = planExtractFunction(parsed, {
        newFunctionName: "g",
        start,
        end: start + body.length,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const out = applyRangeEdits(result.source!, result.edits!);
      expect(out).toContain("({ a, z } = g(");
      expect(out).toContain("return { a, z }");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("freshness product surfaces and generated meta pages are sorted", () => {
    const product = buildProduct();
    // commands sort by filename (name + ".md") — frontmatter guarantees the
    // name matches the filename, so "ashlr-x-status.md" precedes "ashlr-x.md".
    const commandFiles = product.commands.map((c) => `${c.name}.md`);
    const skillNames = product.workflowSkills.map((s) => s.name);
    expect(commandFiles).toEqual(sortedCopy(commandFiles));
    expect(skillNames).toEqual(sortedCopy(skillNames));
    const metaRaw = generatedFiles().get("site/content/docs/skills/meta.json");
    expect(metaRaw).toBeDefined();
    const meta = JSON.parse(metaRaw!) as { pages: string[] };
    const slugs = meta.pages.slice(1); // [0] is the literal "index" landing page
    expect(slugs).toEqual(sortedCopy(slugs));
  });
});
