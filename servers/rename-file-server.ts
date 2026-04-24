/**
 * ashlr-rename-file — v1.19 module-path refactor.
 *
 * Complements v1.18's `ashlr__edit_structural rename-cross-file` (which
 * renames IDENTIFIERS across files). This tool renames MODULE PATHS: you
 * move/rename a source file on disk and every import specifier in the
 * project that resolved to it is rewritten in-place.
 *
 * Scope rules:
 *   - `from` / `to` are both cwd-clamped (clampToCwd). Any path that escapes
 *     cwd → refusal.
 *   - `from` must exist as a regular file; `to` must not exist.
 *   - `to`'s parent directory must already exist (we don't auto-create dirs
 *     — the caller is explicit about where the file lands).
 *   - Binary files (by extension) are rejected so we don't ever mutate
 *     non-source assets.
 *
 * Importer detection (ripgrep-based, not a naive whole-tree scan):
 *   - We shell out to `rg -l` to enumerate files containing the *basename*
 *     of `from` (without extension) in an import/require/export-from
 *     statement, bounded to .ts/.tsx/.js/.jsx files and subject to the
 *     `roots` filter if provided.
 *   - For each candidate, we parse every `import ... from "spec"`,
 *     `require("spec")`, and `export ... from "spec"` string literal and
 *     resolve it relative to the importer. If the resolved target equals
 *     `from`, the specifier is rewritten to the appropriate relative form
 *     of `to`.
 *   - Extension elision (`./foo` → `./foo.ts`) and index resolution
 *     (`./foo` → `./foo/index.ts`) are both honored. The rewritten
 *     specifier preserves the caller's original extension style (if the
 *     import omitted the extension, the new specifier does too).
 *   - Bare package specifiers (`react`, `@scope/pkg`) are never touched.
 *
 * Apply semantics:
 *   - Dry run lists every planned edit; nothing is written and the file is
 *     not moved.
 *   - On apply: every text edit is written first, then `fs.rename(from, to)`.
 *     If any edit fails to write, the remaining writes are skipped and the
 *     already-written files are best-effort rolled back from our in-memory
 *     pre-image. We only rename `from → to` if every text edit succeeded.
 *   - No force mode. No symlink following. Intentionally tight scope for v1.
 */

import { access, readFile, rename, stat, writeFile } from "fs/promises";
import { accessSync, realpathSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenameFileArgs {
  from: string;
  to: string;
  dryRun?: boolean;
  maxFiles?: number;
  roots?: string[];
}

export interface ImporterEdit {
  /** Absolute path of the importer file. */
  path: string;
  /** Byte offsets into the importer's source (inside the string literal). */
  start: number;
  end: number;
  /** The original specifier text (without surrounding quotes). */
  oldSpecifier: string;
  /** The rewritten specifier text (without surrounding quotes). */
  newSpecifier: string;
}

export interface RenameFilePlan {
  from: string;
  to: string;
  /** All edits grouped by importer. Each inner array is non-empty. */
  edits: Array<{ path: string; edits: ImporterEdit[]; source: string }>;
  /** Candidate files rg surfaced but that had no matching specifier. */
  skipped: number;
  /** Non-fatal warnings (e.g., maxFiles truncation). */
  warnings: string[];
}

export type RenameFileResult =
  | { ok: true; plan: RenameFilePlan; written: number; renamed: boolean }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 200;

/** Source file extensions we'll follow. */
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Binary extensions we flat-out refuse — catching user accidents like
 * `ashlr__rename_file from=assets/hero.png to=assets/banner.png`. This is
 * NOT a security check (the caller could still move these with `mv`); it's
 * a contract: this tool understands import-path semantics, which binaries
 * don't have. Keep the list conservative — if an unknown extension slips
 * through, the downstream rg scan will simply return zero importers.
 */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".pdf", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".ogg", ".wav", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".so", ".dylib", ".dll", ".exe", ".class",
  ".db", ".sqlite", ".sqlite3",
]);

// ---------------------------------------------------------------------------
// rg resolver (duplicated from efficiency-server to avoid circular import)
// ---------------------------------------------------------------------------

function resolveRg(): string {
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    // codex vendor bundle (present on some macOS dev machines)
    "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg",
    "/opt/homebrew/lib/node_modules/@openai/codex/bin/rg",
  ];
  const bun = (globalThis as { Bun?: { which(bin: string): string | null } }).Bun;
  const fromBun = bun ? bun.which("rg") : null;
  if (fromBun) return fromBun;
  for (const p of candidates) {
    try {
      accessSync(p);
      return p;
    } catch {
      // keep trying
    }
  }
  return "rg";
}

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an import specifier against the importer's directory to an
 * absolute filesystem path. Handles extension elision and `index.<ext>`
 * lookup. Returns `null` for bare specifiers (packages) and unresolvable
 * paths — callers MUST check for null before comparing.
 */
function resolveSpecifier(importerDir: string, spec: string): string | null {
  // Bare specifier: doesn't start with `.` or `/`. Examples: `react`,
  // `@scope/pkg`, `node:fs`. Never a candidate for rewrite.
  if (!spec.startsWith(".") && !spec.startsWith("/") && !isAbsolute(spec)) {
    return null;
  }

  const base = isAbsolute(spec) ? spec : resolve(importerDir, spec);

  // 1. Exact path as written — but ONLY if it's a regular file. If `base`
  //    is a directory (e.g., `./foo` where `foo/` is a dir with index.ts),
  //    Node resolves it via the index lookup below, not as the dir itself.
  if (regularFileExistsSync(base)) return base;

  // 2. Extension elision: spec lacks an extension, try each source ext.
  if (!SOURCE_EXTS.has(extname(base))) {
    for (const ext of SOURCE_EXTS) {
      if (regularFileExistsSync(base + ext)) return base + ext;
    }
    // 3. Directory + index.<ext>
    for (const ext of SOURCE_EXTS) {
      const idx = join(base, "index" + ext);
      if (regularFileExistsSync(idx)) return idx;
    }
  }

  return null;
}

function regularFileExistsSync(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Given the absolute path of the importer, the absolute path of the
 * new target (`to`), and the original specifier text (so we can preserve
 * extension style + index style), produce the new specifier string.
 *
 *   - Always use POSIX separators (import specifiers are URL-ish).
 *   - Prefix with `./` if the relative path is in the same dir (otherwise
 *     Node/TS treats it as a bare package).
 *   - If the original specifier omitted the extension, the new one does too.
 *   - If the original specifier resolved via `index.<ext>`, strip
 *     `/index` from the new one so it stays symmetric.
 */
function computeNewSpecifier(
  importerDir: string,
  toAbs: string,
  oldSpec: string,
  resolvedFromAbs: string,
): string {
  let rel = relative(importerDir, toAbs);
  // Normalize to POSIX separators — import strings are always forward slash.
  if (sep !== "/") rel = rel.split(sep).join("/");

  // Did the original specifier carry an extension we recognize?
  const oldExt = posixExtname(oldSpec);
  const hadExt = SOURCE_EXTS.has(oldExt);

  // Did the original resolve via `index.<ext>` (and did the spec NOT
  // spell out `/index` itself)?
  const toFile = basenameNoSepStripped(resolvedFromAbs);
  const resolvedViaIndex =
    /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(toFile) &&
    !oldSpec.endsWith("/index") &&
    !/\/index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(oldSpec);

  // If the new `to` is also an `index.<ext>` and the caller imported via
  // directory-index, strip the `/index.<ext>` tail so `"./bar"` continues
  // to resolve via index. If the caller spelled out `/index`, leave it be.
  if (resolvedViaIndex) {
    const tail = /\/index\.(ts|tsx|js|jsx|mjs|cjs)$/;
    if (tail.test(rel)) rel = rel.replace(tail, "");
  } else if (!hadExt) {
    // Extension elision: the original spec omitted the extension. Strip
    // the extension from the new one so we stay consistent.
    const ext = posixExtname(rel);
    if (SOURCE_EXTS.has(ext)) {
      rel = rel.slice(0, -ext.length);
    }
  }

  // Ensure relative prefix. `relative()` may produce `bar.ts` (same dir) —
  // which as an import spec is a bare package, not a relative import.
  if (!rel.startsWith(".") && !rel.startsWith("/")) {
    rel = "./" + rel;
  }

  return rel;
}

function posixExtname(p: string): string {
  const idx = p.lastIndexOf(".");
  const slashIdx = p.lastIndexOf("/");
  if (idx < 0 || idx < slashIdx) return "";
  return p.slice(idx);
}

function basenameNoSepStripped(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// Import-specifier extraction
// ---------------------------------------------------------------------------

/**
 * Regex matching an import/require/export-from statement's string literal
 * and capturing the specifier text plus quote character. Covers:
 *
 *   import x from "foo"
 *   import { a, b } from 'foo'
 *   import "foo"
 *   import * as x from "foo"
 *   export { x } from "foo"
 *   export * from "foo"
 *   const x = require("foo")
 *   const x = require('foo')
 *   await import("foo")
 *
 * Group 1: specifier text. Quote character is captured so we can match the
 * closing quote without cross-pollinating on mismatched quotes.
 *
 * Deliberately narrow: we don't try to handle template literals or
 * computed dynamic imports. v1 targets the 99% case; anything exotic is
 * left untouched and the caller sees a "no matching specifier" skip.
 */
const IMPORT_RE =
  // eslint-disable-next-line no-useless-escape
  /(?:^|[^\w$])(?:import|export)(?:[\s\S]*?)\s+from\s+(['"])([^'"\n]+?)\1|(?:^|[^\w$])import\s+(['"])([^'"\n]+?)\3|(?:^|[^\w$])(?:require|import)\s*\(\s*(['"])([^'"\n]+?)\5\s*\)/g;

interface RawMatch {
  /** Byte offset of the opening quote (inclusive). */
  quoteStart: number;
  /** Specifier text (without quotes). */
  specifier: string;
  /** Length of specifier text. */
  specLen: number;
}

function extractImportMatches(source: string): RawMatch[] {
  const out: RawMatch[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source))) {
    // Which alternation fired? Check groups 2 / 4 / 6.
    let quote: string;
    let spec: string;
    if (m[2] !== undefined) {
      quote = m[1]!;
      spec = m[2]!;
    } else if (m[4] !== undefined) {
      quote = m[3]!;
      spec = m[4]!;
    } else if (m[6] !== undefined) {
      quote = m[5]!;
      spec = m[6]!;
    } else {
      continue;
    }
    // Find the opening quote position inside the full match. m.index points
    // at the leading separator/newline — scan forward for the quote.
    const quoteIdx = source.indexOf(quote + spec + quote, m.index);
    if (quoteIdx < 0) continue;
    out.push({
      quoteStart: quoteIdx,
      specifier: spec,
      specLen: spec.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate discovery via ripgrep
// ---------------------------------------------------------------------------

/**
 * Return the list of absolute file paths that could plausibly import
 * `fromAbs` — files that mention the basename (with or without extension)
 * inside an import/require/export-from string literal. Falls back to a
 * broad list of any TS/JS files containing the basename if rg is unavailable.
 */
function discoverCandidates(
  fromAbs: string,
  searchRoots: string[],
  cap: number,
): { files: string[]; truncated: boolean } {
  const base = basenameNoSepStripped(fromAbs);
  const baseNoExt = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  // For directory-index files (`foo/index.ts`), the importing specifier is
  // typically the PARENT dir (`./foo`), not `index`. We add the parent dir
  // name as a second prefilter needle so those importers surface.
  const parentName =
    /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base)
      ? basenameNoSepStripped(dirname(fromAbs))
      : null;

  const rg = resolveRg();
  const files = new Set<string>();
  let truncated = false;

  const runRg = (needle: string): void => {
    if (!needle) return;
    const args = [
      "--files-with-matches",
      "--fixed-strings",
      "--glob", "*.ts",
      "--glob", "*.tsx",
      "--glob", "*.js",
      "--glob", "*.jsx",
      "--glob", "*.mjs",
      "--glob", "*.cjs",
      needle,
      ...searchRoots,
    ];
    const res = spawnSync(rg, args, { encoding: "utf-8", timeout: 15_000 });
    if (res.error || (res.status !== 0 && res.status !== 1)) return;
    for (const line of (res.stdout ?? "").split("\n")) {
      const p = line.trim();
      if (!p) continue;
      if (files.size >= cap) {
        truncated = true;
        return;
      }
      // Canonicalize so symlinked tmpdirs on macOS (/var → /private/var)
      // produce paths comparable to the clamp's canonicalized `from`.
      let canonical: string;
      try {
        canonical = realpathSync(p);
      } catch {
        canonical = p;
      }
      files.add(canonical);
    }
  };

  runRg(baseNoExt);
  if (base !== baseNoExt) runRg(base);
  if (parentName && parentName !== baseNoExt) runRg(parentName);

  return { files: Array.from(files), truncated };
}

// ---------------------------------------------------------------------------
// Core planner
// ---------------------------------------------------------------------------

export async function planRenameFile(args: RenameFileArgs): Promise<RenameFileResult> {
  const { from, to, maxFiles = DEFAULT_MAX_FILES, roots } = args;

  if (!from || typeof from !== "string") {
    return { ok: false, reason: "'from' is required" };
  }
  if (!to || typeof to !== "string") {
    return { ok: false, reason: "'to' is required" };
  }

  const fromClamp = clampToCwd(from, "ashlr__rename_file");
  if (!fromClamp.ok) return { ok: false, reason: fromClamp.message };
  const toClamp = clampToCwd(to, "ashlr__rename_file");
  if (!toClamp.ok) return { ok: false, reason: toClamp.message };

  const fromAbs = fromClamp.abs;
  const toAbs = toClamp.abs;

  // Same-path is a no-op refusal so the caller can't accidentally truncate
  // the file via self-rename.
  if (fromAbs === toAbs) {
    return { ok: false, reason: `'from' and 'to' resolve to the same path: ${fromAbs}` };
  }

  // `from` must be a regular file.
  let fromStat;
  try {
    fromStat = await stat(fromAbs);
  } catch {
    return { ok: false, reason: `'from' does not exist: ${from}` };
  }
  if (!fromStat.isFile()) {
    return { ok: false, reason: `'from' is not a regular file: ${from}` };
  }

  // Binary-file refusal.
  const fromExt = extname(fromAbs).toLowerCase();
  if (BINARY_EXTS.has(fromExt)) {
    return { ok: false, reason: `binary files are not supported (extension ${fromExt}): ${from}` };
  }
  const toExt = extname(toAbs).toLowerCase();
  if (BINARY_EXTS.has(toExt)) {
    return { ok: false, reason: `binary files are not supported (extension ${toExt}): ${to}` };
  }

  // `to` must NOT exist.
  try {
    await access(toAbs);
    return { ok: false, reason: `'to' already exists: ${to}` };
  } catch {
    // desired: does not exist
  }

  // `to`'s parent directory MUST exist.
  const toDir = dirname(toAbs);
  try {
    const s = await stat(toDir);
    if (!s.isDirectory()) {
      return { ok: false, reason: `destination parent is not a directory: ${toDir}` };
    }
  } catch {
    return { ok: false, reason: `destination directory does not exist (create it first): ${toDir}` };
  }

  // Determine the search roots. If the caller passed `roots`, clamp each.
  // Otherwise default to cwd.
  const searchRoots: string[] = [];
  if (Array.isArray(roots) && roots.length > 0) {
    for (const r of roots) {
      const c = clampToCwd(r, "ashlr__rename_file");
      if (!c.ok) return { ok: false, reason: c.message };
      searchRoots.push(c.abs);
    }
  } else {
    searchRoots.push(process.cwd());
  }

  // Discover candidate importers.
  const { files: candidates, truncated } = discoverCandidates(fromAbs, searchRoots, maxFiles);

  const warnings: string[] = [];
  if (truncated) {
    warnings.push(
      `ripgrep returned more than ${maxFiles} candidates — only the first ${maxFiles} were scanned. ` +
      `Rerun with a larger maxFiles or narrower roots.`,
    );
  }

  // For each candidate, parse import specifiers and resolve to an abs path.
  const perFileEdits: Array<{ path: string; edits: ImporterEdit[]; source: string }> = [];
  let skipped = 0;

  for (const importer of candidates) {
    // Skip the renamed file itself — relevant edits don't apply to it
    // (its own path is what we're changing, not a reference to another file).
    if (importer === fromAbs) {
      skipped++;
      continue;
    }
    let source: string;
    try {
      source = await readFile(importer, "utf-8");
    } catch {
      skipped++;
      continue;
    }

    const matches = extractImportMatches(source);
    if (matches.length === 0) {
      skipped++;
      continue;
    }

    const importerDir = dirname(importer);
    const edits: ImporterEdit[] = [];

    for (const m of matches) {
      const resolved = resolveSpecifier(importerDir, m.specifier);
      if (!resolved || resolved !== fromAbs) continue;

      const newSpec = computeNewSpecifier(importerDir, toAbs, m.specifier, resolved);
      if (newSpec === m.specifier) continue; // already correct, no-op

      edits.push({
        path: importer,
        start: m.quoteStart + 1, // inside opening quote
        end: m.quoteStart + 1 + m.specLen, // inside closing quote
        oldSpecifier: m.specifier,
        newSpecifier: newSpec,
      });
    }

    if (edits.length === 0) {
      skipped++;
      continue;
    }
    perFileEdits.push({ path: importer, edits, source });
  }

  return {
    ok: true,
    plan: {
      from: fromAbs,
      to: toAbs,
      edits: perFileEdits,
      skipped,
      warnings,
    },
    written: 0,
    renamed: false,
  };
}

// ---------------------------------------------------------------------------
// Apply (write edits, then rename)
// ---------------------------------------------------------------------------

/**
 * Apply a plan from `planRenameFile`. Writes each importer's updated text,
 * then renames `from → to`. On any write failure, best-effort rolls back
 * every already-written importer using the cached pre-image. The file
 * itself is only renamed if every text edit succeeded.
 *
 * Concurrency note: we sequence writes (not parallel) because a failure
 * rollback is simpler when we know exactly which files made it to disk.
 */
export async function applyRenameFilePlan(
  plan: RenameFilePlan,
): Promise<{ written: number; renamed: boolean; rollbackWarnings: string[] }> {
  const writtenPaths: Array<{ path: string; original: string }> = [];
  const rollbackWarnings: string[] = [];

  for (const fe of plan.edits) {
    const updated = applyEditsToSource(fe.source, fe.edits);
    try {
      await writeFile(fe.path, updated, "utf-8");
      writtenPaths.push({ path: fe.path, original: fe.source });
    } catch (err) {
      // Rollback everything we wrote.
      for (const prev of writtenPaths) {
        try {
          await writeFile(prev.path, prev.original, "utf-8");
        } catch (rbErr) {
          rollbackWarnings.push(
            `rollback failed for ${prev.path}: ${(rbErr as Error).message}`,
          );
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to write ${fe.path}: ${msg}`);
    }
  }

  // All text edits written — now rename the file itself.
  try {
    await rename(plan.from, plan.to);
  } catch (err) {
    // File rename failed — roll back importer edits so the codebase stays
    // consistent (references still point at the un-moved file).
    for (const prev of writtenPaths) {
      try {
        await writeFile(prev.path, prev.original, "utf-8");
      } catch (rbErr) {
        rollbackWarnings.push(
          `rollback failed for ${prev.path}: ${(rbErr as Error).message}`,
        );
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to rename ${plan.from} → ${plan.to}: ${msg}`);
  }

  return { written: writtenPaths.length, renamed: true, rollbackWarnings };
}

/**
 * Apply a set of ImporterEdits (all against the same source) and return
 * the updated text. Edits are applied right-to-left so earlier offsets
 * remain valid throughout the rewrite. Overlap detection is a sanity net —
 * our extractor never emits overlapping ranges, but a future extension
 * might, and silently miscounting bytes would corrupt the file.
 */
function applyEditsToSource(source: string, edits: ImporterEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i]!.start < sorted[i + 1]!.end) {
      throw new Error("rename-file: overlapping edits detected");
    }
  }
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.newSpecifier + out.slice(e.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level callable (used by the MCP handler)
// ---------------------------------------------------------------------------

export async function ashlrRenameFile(args: RenameFileArgs): Promise<string> {
  const planRes = await planRenameFile(args);
  if (!planRes.ok) {
    throw new Error(planRes.reason);
  }
  const { plan } = planRes;
  const dryRun = args.dryRun === true;

  const importerCount = plan.edits.length;
  const totalEdits = plan.edits.reduce((s, f) => s + f.edits.length, 0);

  const lines: string[] = [];
  lines.push(
    `[ashlr__rename_file] ${dryRun ? "(dry run) " : ""}${plan.from} → ${plan.to}`,
  );
  lines.push(
    `  ${importerCount} importer${importerCount === 1 ? "" : "s"}, ${totalEdits} specifier${totalEdits === 1 ? "" : "s"} updated, ${plan.skipped} candidate${plan.skipped === 1 ? "" : "s"} skipped`,
  );
  if (plan.warnings.length > 0) {
    lines.push("  warnings:");
    for (const w of plan.warnings) lines.push(`    ${w}`);
  }

  // List every planned edit when the set is small enough to read at a glance.
  if (importerCount <= 20) {
    for (const fe of plan.edits) {
      lines.push(`  ${fe.path}`);
      for (const e of fe.edits) {
        lines.push(`    "${e.oldSpecifier}" → "${e.newSpecifier}"`);
      }
    }
  }

  if (dryRun) {
    lines.push("  (dry run — no files written, file not renamed)");
    return lines.join("\n");
  }

  if (importerCount === 0) {
    // Still rename the file itself — the caller asked us to move it; the
    // absence of importers just means nothing else needs updating.
    await rename(plan.from, plan.to);
    lines.push("  renamed");
    return lines.join("\n");
  }

  const applied = await applyRenameFilePlan(plan);
  lines.push(`  ${applied.written} file${applied.written === 1 ? "" : "s"} written, renamed`);
  if (applied.rollbackWarnings.length > 0) {
    lines.push("  rollback warnings:");
    for (const w of applied.rollbackWarnings) lines.push(`    ${w}`);
  }
  return lines.join("\n");
}
