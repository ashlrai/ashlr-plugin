/**
 * mdx-angle-bracket-lint.test.ts — tests for the repo's mdx-lint gate.
 *
 * `bun run mdx-lint` runs on every `bun run check`, but its scanner
 * (stripFences + lintContent) had no tests: nothing pinned which contexts
 * (code fences, inline code, HTML comments, frontmatter) are exempt, which
 * tokens are flagged, or the CLI's exit-code contract. These tests use
 * synthetic content and fixture files — no repo docs are read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lintContent, stripFences } from "../scripts/mdx-angle-bracket-lint.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("stripFences", () => {
  test("blanks fenced code blocks while keeping line positions", () => {
    const content = "intro\n```bash\necho <task>\n```\nOUTRO";
    const stripped = stripFences(content);
    expect(stripped).toContain("intro");
    expect(stripped).toContain("OUTRO");
    expect(stripped).not.toContain("<task>");
    expect(stripped.split("\n")).toHaveLength(5);
  });

  test("blanks inline code spans, HTML comments and frontmatter", () => {
    const content = [
      "---",
      "title: has <angle> inside frontmatter",
      "---",
      "body with `<inline>` span",
      "<!-- a <hidden> comment -->",
      "plain line",
    ].join("\n");
    const stripped = stripFences(content);
    expect(stripped).not.toContain("<angle>");
    expect(stripped).not.toContain("<inline>");
    expect(stripped).not.toContain("<hidden>");
    expect(stripped).toContain("plain line");
  });

  test("leaves prose angle brackets in place", () => {
    expect(stripFences("use the <task> token")).toContain("<task>");
  });
});

describe("lintContent", () => {
  test("flags an unbacked lowercase token with file, line and column", () => {
    const errors = lintContent("commands/x.md", "first\nuse a <task> here\n");
    expect(errors).toEqual([{ file: "commands/x.md", line: 2, col: 7, match: "<task>" }]);
  });

  test("known HTML tags are allowed", () => {
    expect(lintContent("a.md", "a <br> b <details><summary>t</summary></details>")).toEqual([]);
  });

  test("tokens inside fences, inline code and comments are not flagged", () => {
    const content = [
      "```md",
      "placeholder <task>",
      "```",
      "wrap it as `<task>` instead",
      "<!-- legacy <amount> note -->",
    ].join("\n");
    expect(lintContent("a.md", content)).toEqual([]);
  });

  test("reports every token on a line and hyphenated names", () => {
    const errors = lintContent("a.md", "<task> costs <amount-per-day> total");
    expect(errors.map((e) => e.match)).toEqual(["<task>", "<amount-per-day>"]);
    expect(errors[0]).toMatchObject({ line: 1, col: 1 });
    expect(errors[1]).toMatchObject({ line: 1, col: 14 });
  });

  test("capitalized tokens are flagged too — the scanner is case-insensitive", () => {
    // <Tabs> is real JSX, but unimported it breaks the MDX build just like
    // <task>, so the regex keeps the i flag and flags both.
    expect(lintContent("a.md", "render <Tabs> once").map((e) => e.match)).toEqual(["<Tabs>"]);
  });
});

describe("CLI", () => {
  const script = resolve(__dirname, "..", "scripts", "mdx-angle-bracket-lint.ts");

  function run(args: string[]) {
    return Bun.spawnSync([process.execPath, script, ...args], { cwd: dirs[0]! });
  }

  test("a clean file exits 0 and an unwrapped token exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "ashlr-mdx-lint-"));
    dirs.push(root);
    const clean = join(root, "clean.mdx");
    const dirty = join(root, "dirty.mdx");
    writeFileSync(clean, "Prose with `<task>` wrapped correctly.\n");
    writeFileSync(dirty, "Prose with a bare <task> token.\n");

    const ok = run([clean]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("mdx-lint: ok (1 files scanned)");

    const bad = run([dirty]);
    expect(bad.exitCode).toBe(1);
    const err = bad.stderr.toString();
    expect(err).toContain("dirty.mdx:1:19 unwrapped angle-bracket token: <task>");
    expect(err).toContain("Fix: wrap them in backticks");
  });

  test("--quiet keeps the exit code and drops the diagnostics", () => {
    const root = mkdtempSync(join(tmpdir(), "ashlr-mdx-lint-"));
    dirs.push(root);
    const dirty = join(root, "dirty.mdx");
    writeFileSync(dirty, "bare <task>\n");

    const bad = run([dirty, "--quiet"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString().trim()).toBe("");
  });

  test("a missing target file is skipped rather than failing the run", () => {
    const root = mkdtempSync(join(tmpdir(), "ashlr-mdx-lint-"));
    dirs.push(root);
    const ok = run([join(root, "does-not-exist.md")]);
    expect(ok.exitCode).toBe(0);
  });
});
