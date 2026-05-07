#!/usr/bin/env bun
/**
 * mdx-angle-bracket-lint.ts — flag unbacked `<placeholder>` tokens in body
 * prose of `commands/*.md` and `site/content/docs/skills/*.mdx`.
 *
 * Why: Fumadocs' MDX parser interprets bare angle-bracket tokens
 * (e.g. `<task>`, `<amount>`, `<level>`) as JSX tags. The Vercel docs build
 * fails when these appear in prose. The convention is to wrap them in inline
 * backticks so MDX renders them as literal `<task>` text.
 *
 * Strategy:
 *   - Read every target file
 *   - Skip code fences (``` ... ```), inline-code spans (`...`), HTML comments
 *   - Skip frontmatter (--- ... ---) and YAML inside fences
 *   - For remaining content, flag any `<word-or-placeholder>` not preceded by
 *     a real-tag whitelist (e.g. `<br>`, `<details>`, `<summary>`, `<a ...>`,
 *     `<img ...>`, etc.)
 *
 * Usage:
 *   bun run scripts/mdx-angle-bracket-lint.ts                # lint all targets, exit non-zero on fail
 *   bun run scripts/mdx-angle-bracket-lint.ts <file>...      # lint specific files
 *   bun run scripts/mdx-angle-bracket-lint.ts --quiet        # exit code only, no per-file output
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

const KNOWN_HTML_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "blockquote", "br",
  "button", "canvas", "caption", "code", "col", "colgroup", "data", "datalist",
  "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "head", "header", "hr", "html", "i", "iframe", "img", "input",
  "ins", "kbd", "label", "legend", "li", "main", "mark", "menu", "meta",
  "meter", "nav", "noscript", "object", "ol", "optgroup", "option", "output",
  "p", "param", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s",
  "samp", "script", "section", "select", "small", "source", "span", "strong",
  "style", "sub", "summary", "sup", "svg", "table", "tbody", "td", "template",
  "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u",
  "ul", "var", "video", "wbr",
  // Closing tags appear as </tag>; allow common patterns
  "br/", "hr/",
]);

interface LintError {
  file: string;
  line: number;
  col: number;
  match: string;
}

/** Strip code fences and inline-code spans from a line array, in-place. */
export function stripFences(content: string): string {
  // Remove fenced code blocks first.
  let out = content.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));
  // Remove inline code spans `...`
  out = out.replace(/`[^`\n]+`/g, (m) => m.replace(/[^\n]/g, " "));
  // Remove HTML comments
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  // Strip YAML frontmatter at top of file (--- through ---)
  out = out.replace(/^---\n[\s\S]*?\n---\n/, (m) => m.replace(/[^\n]/g, " "));
  return out;
}

/** Lint a single file's content. Returns array of errors (empty == ok). */
export function lintContent(file: string, content: string): LintError[] {
  const stripped = stripFences(content);
  const errors: LintError[] = [];
  const lines = stripped.split("\n");
  // Match `<word>` and `<word>...</word>` opening, but NOT real HTML/JSX tags
  // (those have attributes or are in known list).
  // We're conservative: any `<NAME>` where NAME is lowercase letters or has
  // hyphens but no `=`, no `/`, no spaces, and not in the known tag set.
  const TOKEN_RE = /<([a-z][a-z0-9_-]*)>/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(line)) !== null) {
      const tag = m[1]!.toLowerCase();
      if (KNOWN_HTML_TAGS.has(tag)) continue;
      errors.push({ file, line: i + 1, col: m.index + 1, match: m[0] });
    }
  }
  return errors;
}

function listMdAndMdx(dir: string): string[] {
  const out: string[] = [];
  if (!statSafe(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && (full.endsWith(".md") || full.endsWith(".mdx"))) out.push(full);
    }
  }
  return out;
}

function statSafe(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const explicit = args.filter((a) => !a.startsWith("--"));

  const cwd = process.cwd();
  const targets: string[] = [];
  if (explicit.length > 0) {
    for (const t of explicit) targets.push(resolve(cwd, t));
  } else {
    targets.push(...listMdAndMdx(join(cwd, "commands")));
    targets.push(...listMdAndMdx(join(cwd, "site", "content", "docs", "skills")));
  }

  let totalErrors = 0;
  const seenFiles = new Set<string>();
  for (const file of targets) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    const errors = lintContent(file, content);
    if (errors.length === 0) continue;
    totalErrors += errors.length;
    if (!quiet) {
      for (const e of errors) {
        process.stderr.write(`${e.file}:${e.line}:${e.col} unwrapped angle-bracket token: ${e.match}\n`);
      }
    }
  }

  if (totalErrors === 0) {
    if (!quiet) process.stdout.write(`mdx-lint: ok (${seenFiles.size} files scanned)\n`);
    process.exit(0);
  }
  if (!quiet) {
    process.stderr.write(`\nmdx-lint: ${totalErrors} unwrapped angle-bracket token(s) across ${seenFiles.size} files.\n`);
    process.stderr.write(`Fix: wrap them in backticks (e.g. \`<level>\`) so MDX renders them as literal text.\n`);
  }
  process.exit(1);
}

if (import.meta.main) {
  void main();
}
