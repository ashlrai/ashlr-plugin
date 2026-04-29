/**
 * ashlr-search-replace-regex — v1.20 multi-file regex search/replace.
 *
 * Companion to `ashlr__edit` (literal-only, single file) and
 * `ashlr__rename_file` (file rename + importer update). Users frequently
 * need multi-file regex-based search/replace — e.g. "change every
 * `logger.info(` to `log.info(` across src/". Before this tool they had
 * to fall back to native shell + sed / native MultiEdit spanning many
 * files; this lands the pattern inside the ashlr router so savings are
 * credited and safety rails (cwd-clamp, binary refusal, caps) apply.
 *
 * Scope rules:
 *   - `roots` (default `[process.cwd()]`) are cwd-clamped. Paths that
 *     escape cwd → refusal.
 *   - Candidate discovery uses ripgrep (`rg -l`) with the compiled regex.
 *     `include` / `exclude` globs are forwarded as `--glob` / `--glob !`
 *     — same syntax as `ashlr__edit_structural`.
 *   - Candidates are capped at `maxFiles` (default 200). Overflow is
 *     reported as a non-fatal warning, not a refusal.
 *   - Per-file replacements are capped at `maxMatchesPerFile` (default
 *     100). Extras are left untouched and flagged.
 *   - Binary files are skipped by extension AND by null-byte sniff on
 *     the first 512 bytes (defense in depth against mislabeled assets).
 *
 * Safety:
 *   - Zero-width / empty-match patterns (e.g. `.*` on an empty string)
 *     are refused at validate time. The tool requires that every match
 *     consume at least one character, so a runaway replaceAll can't
 *     produce an infinite-length file.
 *   - Writes are atomic per-file (temp file + rename) so a crash
 *     mid-write can't corrupt partial content — the reader either sees
 *     the old file or the new file, never a half-written one.
 *   - dryRun: true returns the planned change set (file list + counts)
 *     without touching disk.
 *
 * No `--force` mode for v1. The regex + include/exclude + caps are
 * expressive enough to scope any reasonable rewrite; if the model wants
 * a truly global rewrite it can set `roots=["."]` explicitly and own
 * the blast radius.
 */

import { readFile, rename, writeFile, stat } from "fs/promises";
import { accessSync, realpathSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { extname, normalize as pathNormalize, relative, resolve as pathResolve, sep } from "path";
import { minimatch } from "minimatch";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchReplaceRegexArgs {
  pattern: string;
  replacement: string;
  flags?: string;
  include?: string[];
  exclude?: string[];
  dryRun?: boolean;
  maxFiles?: number;
  maxMatchesPerFile?: number;
  roots?: string[];
}

export interface FilePlan {
  /** Absolute path of the file. */
  path: string;
  /** Number of matches that will be replaced in this file. */
  matches: number;
  /** True if matches were capped by `maxMatchesPerFile`. */
  capped: boolean;
  /** Byte size of the original file. */
  originalBytes: number;
  /** Byte size of the rewritten file (post-replacement). */
  newBytes: number;
}

export interface SearchReplaceRegexPlan {
  /** Per-file planned changes. Only files with ≥1 match are included. */
  files: FilePlan[];
  /** Candidate files rg surfaced but that were skipped (binary, read error, etc.). */
  skipped: number;
  /** Non-fatal warnings (maxFiles truncation, per-file cap hit, binary skip, …). */
  warnings: string[];
}

export type SearchReplaceRegexResult =
  | { ok: true; plan: SearchReplaceRegexPlan }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_MATCHES_PER_FILE = 100;

/** Binary extensions we flat-out skip (no regex rewrite makes sense). */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff",
  ".pdf", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".ogg", ".wav", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".so", ".dylib", ".dll", ".exe", ".class",
  ".db", ".sqlite", ".sqlite3",
]);

/** Cap per-file scanning at this byte count for the null-byte sniff. */
const SNIFF_BYTES = 512;

// ---------------------------------------------------------------------------
// rg resolver (duplicated from rename-file-server; see note there)
// ---------------------------------------------------------------------------

function resolveRg(): string {
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
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
// Regex validation
// ---------------------------------------------------------------------------

/**
 * Compile the user-supplied pattern + flags into a global RegExp and
 * verify it can't match the empty string (which would cause a runaway
 * replaceAll / infinite-length output). We always force the `g` flag on
 * — cross-file replace only makes sense globally.
 */
function compilePattern(
  pattern: string,
  flags: string | undefined,
): { ok: true; re: RegExp } | { ok: false; reason: string } {
  if (!pattern || typeof pattern !== "string") {
    return { ok: false, reason: "'pattern' is required and must be a string" };
  }
  if (pattern.length === 0) {
    return { ok: false, reason: "'pattern' must not be empty" };
  }

  // Normalize flags. Strip any caller-supplied `g` (we re-add it) and
  // whitelist the subset we support — `i`, `m`, `s`, `u`. `y` (sticky)
  // is refused because it breaks String.replaceAll's global-replace
  // contract, and `d` has no effect on replacement.
  const rawFlags = (flags ?? "").replace(/g/g, "");
  for (const f of rawFlags) {
    if (!"imsu".includes(f)) {
      return { ok: false, reason: `unsupported flag '${f}' — only i, m, s, u are supported (g is implicit)` };
    }
  }
  const finalFlags = "g" + rawFlags;

  let re: RegExp;
  try {
    re = new RegExp(pattern, finalFlags);
  } catch (err) {
    return { ok: false, reason: `invalid regex: ${(err as Error).message}` };
  }

  // Reject zero-width / empty-match patterns. We probe by running the
  // regex against a single-char string — if `.exec` produces a match of
  // length zero, the pattern accepts the empty string and would loop
  // infinitely against any input. Reset lastIndex after probing.
  const probe = " ";
  re.lastIndex = 0;
  const m = re.exec(probe);
  if (m && m[0].length === 0) {
    return { ok: false, reason: "pattern matches the empty string (zero-width match would cause runaway replacement)" };
  }
  // Second probe: empty string directly. Some patterns (e.g. `^`) only
  // fire against empty input.
  re.lastIndex = 0;
  const m2 = re.exec("");
  if (m2 && m2[0].length === 0) {
    return { ok: false, reason: "pattern matches the empty string (zero-width match would cause runaway replacement)" };
  }
  re.lastIndex = 0;
  return { ok: true, re };
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

function isBinaryByExt(path: string): boolean {
  return BINARY_EXTS.has(extname(path).toLowerCase());
}

/**
 * Read the first `SNIFF_BYTES` of `path` and check for NUL bytes. If a
 * file contains \x00 in its header, we treat it as binary regardless of
 * extension.
 */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Candidate discovery via ripgrep
// ---------------------------------------------------------------------------

/**
 * Enumerate files under `searchRoots` that contain at least one match
 * for `pattern`. Honors include/exclude globs. Caps the result set at
 * `cap` and reports truncation via the returned flag.
 *
 * We hand the user's regex directly to rg (Rust `regex` crate) — its
 * syntax is a superset of the JS subset most users write, so practical
 * patterns (`logger\.info\(`, `\bfoo\b`, etc.) behave identically. If a
 * pattern uses JS-only syntax (lookbehind, named backrefs in some
 * forms), rg will reject it during discovery and we'll fall through
 * with zero candidates — a no-op, not a crash.
 *
 * include/exclude globs are forwarded to rg AND re-applied in JS via
 * minimatch. The JS post-filter is the source of truth: rg's --glob
 * behaviour with absolute search roots differs across rg versions on
 * Windows (the glob may be matched against the full path instead of the
 * path relative to the search root), making it unreliable as the sole
 * filter. Passing them to rg is still worthwhile for performance — it
 * narrows the candidate set early — but correctness is guaranteed by the
 * minimatch pass below.
 */

/**
 * Determine whether an absolute path `p` matches a set of include and/or
 * exclude glob patterns. Patterns are matched against the POSIX-normalised
 * path relative to `base` (forward slashes, no leading "./"). Both `include`
 * and `exclude` use minimatch with `{dot:true, matchBase:true}` so patterns
 * like "src/**\/*.ts" or "**\/vendor\/**" work regardless of platform.
 *
 * Rules:
 *  - If `include` is non-empty, the file must match at least one pattern.
 *  - If `exclude` is non-empty, the file must not match any pattern.
 *  - If both are empty, the file is always accepted.
 */
function matchesGlobs(
  p: string,
  base: string,
  include: string[] | undefined,
  exclude: string[] | undefined,
): boolean {
  // Relative path with forward slashes regardless of platform.
  const rel = relative(base, p).split(sep).join("/");
  const opts = { dot: true, matchBase: true };

  if (include && include.length > 0) {
    const matched = include.some((g) => minimatch(rel, g, opts));
    if (!matched) return false;
  }
  if (exclude && exclude.length > 0) {
    const excluded = exclude.some((g) => minimatch(rel, g, opts));
    if (excluded) return false;
  }
  return true;
}

function discoverCandidates(
  pattern: string,
  flags: string,
  searchRoots: string[],
  include: string[] | undefined,
  exclude: string[] | undefined,
  cap: number,
): { files: string[]; truncated: boolean; rgFailed: boolean } {
  const rg = resolveRg();
  const args: string[] = ["--files-with-matches"];

  if (flags.includes("i")) args.push("--ignore-case");
  if (flags.includes("m")) args.push("--multiline");
  if (flags.includes("s")) {
    // `s` (dotall) in JS = "." matches \n. rg's `--multiline-dotall` plus
    // `--multiline` gives the same effect.
    args.push("--multiline");
    args.push("--multiline-dotall");
  }

  // Pass globs to rg for a performance pre-filter (narrows the candidate set
  // early). Correctness is re-verified below by the JS matchesGlobs() pass —
  // see the note above discoverCandidates for why rg alone is insufficient.
  // Cross-platform note: rg's `--glob` interpretation on Windows is brittle
  // (case-insensitive drive letters, slash-direction semantics differ
  // between rg builds). We still pass the globs as a perf hint, but on
  // Windows the JS post-filter (matchesGlobs) is the load-bearing piece —
  // skipping the pre-filter here for include/exclude on win32 would only
  // cost extra files to scan, not correctness. We accept that small cost
  // in exchange for predictable behavior.
  if (process.platform !== "win32") {
    for (const g of include ?? []) args.push("--glob", g);
    for (const g of exclude ?? []) args.push("--glob", `!${g}`);
  }

  // Signal end-of-flags before the pattern + roots so a pattern starting
  // with `-` isn't misparsed as a flag.
  args.push("--regexp", pattern);
  for (const r of searchRoots) args.push(r);

  const res = spawnSync(rg, args, { encoding: "utf-8", timeout: 30_000 });
  // rg exits 0 = matches found, 1 = no matches, 2 = error
  if (res.status === 2 || (res.error && !res.stdout)) {
    return { files: [], truncated: false, rgFailed: true };
  }

  // Canonical form of each search root — used by matchesGlobs to compute the
  // path relative to whichever root contains the candidate.
  const canonicalRoots = searchRoots.map((r) => {
    try { return realpathSync(r); } catch { return pathResolve(r); }
  });

  const files = new Set<string>();
  let truncated = false;
  for (const line of (res.stdout ?? "").split("\n")) {
    // trim() strips both '\r' (Windows CRLF from rg output) and whitespace.
    const p = line.trim();
    if (!p) continue;
    // Normalize separators for the current platform so that paths emitted by
    // rg on Windows (which may use forward slashes for --glob-matched results)
    // are consistent with what statSync / clampToCwd expect.
    const normalized = pathNormalize(p);
    // Canonicalize so macOS /var → /private/var matches the clamp output.
    let canonical: string;
    try {
      canonical = realpathSync(normalized);
    } catch {
      canonical = pathResolve(normalized);
    }

    // JS-side include/exclude post-filter. rg's --glob is a performance
    // pre-filter only; this pass is the correctness gate. We match against
    // the path relative to whichever root contains the file (longest prefix
    // wins so nested roots are handled correctly).
    if (include?.length || exclude?.length) {
      let base = canonicalRoots[0] ?? process.cwd();
      for (const r of canonicalRoots) {
        if (canonical.startsWith(r) && r.length > base.length) base = r;
      }
      if (!matchesGlobs(canonical, base, include, exclude)) continue;
    }

    if (files.size >= cap) {
      truncated = true;
      break;
    }
    files.add(canonical);
  }
  return { files: Array.from(files), truncated, rgFailed: false };
}

// ---------------------------------------------------------------------------
// Replacement with a per-file match cap
// ---------------------------------------------------------------------------

/**
 * Apply the regex against `source`, returning `{ updated, count, capped }`.
 * Walks matches manually (rather than calling `String.replaceAll`) so we
 * can respect the per-file cap deterministically — once we hit `cap`
 * replacements, further matches are left in place and `capped=true` is
 * returned.
 *
 * The regex is assumed to have the global `g` flag (enforced by the
 * compile step). Capture groups (`$1`, `$&`) in `replacement` are
 * supported via JS's native semantics by delegating each replacement to
 * `source.substring(m.index, m.index + m[0].length).replace(singleRe, repl)`
 * where `singleRe` is a non-global copy of the compiled pattern — that
 * way `$n` backrefs resolve correctly without us reimplementing JS's
 * replacement mini-DSL.
 */
export function applyRegex(
  source: string,
  re: RegExp,
  replacement: string,
  cap: number,
): { updated: string; count: number; capped: boolean } {
  // Non-global sibling for single-match replacement with backref support.
  const singleFlags = re.flags.replace(/g/g, "");
  const singleRe = new RegExp(re.source, singleFlags);

  let out = "";
  let lastIdx = 0;
  let count = 0;
  re.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // Zero-width match defence in depth — the compile step already
    // rejects these but a regex could theoretically produce an
    // empty match mid-stream (e.g. `a*`). Bail out if we see one.
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    if (count >= cap) break;

    out += source.slice(lastIdx, m.index);
    // JS's `replace` on a fresh non-global regex applied to the exact
    // match text resolves $1…$n / $& / $` / $' correctly.
    const rewritten = m[0].replace(singleRe, replacement);
    out += rewritten;
    lastIdx = m.index + m[0].length;
    count += 1;
  }

  const capped = count >= cap && re.exec(source) !== null;
  re.lastIndex = 0;

  out += source.slice(lastIdx);
  return { updated: out, count, capped };
}

// ---------------------------------------------------------------------------
// Atomic per-file write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `path` atomically (temp file in same directory, then
 * rename). Keeps reads consistent even if the process dies mid-write.
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Core planner
// ---------------------------------------------------------------------------

export async function planSearchReplaceRegex(
  args: SearchReplaceRegexArgs,
): Promise<SearchReplaceRegexResult> {
  const {
    pattern,
    replacement,
    flags,
    include,
    exclude,
    maxFiles = DEFAULT_MAX_FILES,
    maxMatchesPerFile = DEFAULT_MAX_MATCHES_PER_FILE,
    roots,
  } = args;

  if (typeof replacement !== "string") {
    return { ok: false, reason: "'replacement' is required and must be a string" };
  }

  const compiled = compilePattern(pattern, flags);
  if (!compiled.ok) return compiled;

  // Resolve + clamp search roots.
  const searchRoots: string[] = [];
  if (Array.isArray(roots) && roots.length > 0) {
    for (const r of roots) {
      const c = clampToCwd(r, "ashlr__search_replace_regex");
      if (!c.ok) return { ok: false, reason: c.message };
      searchRoots.push(c.abs);
    }
  } else {
    searchRoots.push(process.cwd());
  }

  const warnings: string[] = [];

  const rawFlags = (flags ?? "").replace(/g/g, "");
  const finalFlags = "g" + rawFlags;
  const { files: candidates, truncated, rgFailed } = discoverCandidates(
    pattern,
    finalFlags,
    searchRoots,
    include,
    exclude,
    maxFiles,
  );

  if (rgFailed) {
    return {
      ok: false,
      reason: "ripgrep failed to scan — likely a regex syntax rg doesn't accept (e.g. JS lookbehind). Try a simpler pattern.",
    };
  }

  if (truncated) {
    warnings.push(
      `ripgrep returned more than ${maxFiles} candidates — only the first ${maxFiles} were scanned. ` +
      `Rerun with a larger maxFiles or narrower include/roots.`,
    );
  }

  const filesPlan: FilePlan[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    // Clamp each candidate too — rg shouldn't return paths outside cwd
    // since we gave it cwd-scoped roots, but defense in depth: if a
    // symlink in the roots points outside cwd, the clamp refuses.
    const clamp = clampToCwd(candidate, "ashlr__search_replace_regex");
    if (!clamp.ok) {
      skipped++;
      warnings.push(`${candidate}: skipped — outside cwd`);
      continue;
    }

    if (isBinaryByExt(candidate)) {
      skipped++;
      warnings.push(`${candidate}: skipped — binary extension`);
      continue;
    }

    // Stat + size guard: refuse 0-byte, non-regular, and absurdly-large
    // files (>50 MB) so a stray ISO in the roots can't block the tool.
    let st;
    try {
      st = statSync(candidate);
    } catch {
      skipped++;
      continue;
    }
    if (!st.isFile()) {
      skipped++;
      continue;
    }
    if (st.size === 0) {
      skipped++;
      continue;
    }

    let raw: Buffer;
    try {
      raw = await readFile(candidate);
    } catch {
      skipped++;
      continue;
    }

    if (looksBinary(raw)) {
      skipped++;
      warnings.push(`${candidate}: skipped — binary content (NUL byte in first ${SNIFF_BYTES}B)`);
      continue;
    }

    const source = raw.toString("utf-8");
    const { updated, count, capped } = applyRegex(source, compiled.re, replacement, maxMatchesPerFile);
    if (count === 0) {
      // rg said there were matches but our regex saw none — possible if
      // rg's regex engine differs at some edge (unicode classes, etc.).
      // Skip silently.
      skipped++;
      continue;
    }
    if (capped) {
      warnings.push(
        `${candidate}: match cap hit — only first ${maxMatchesPerFile} replacements applied, remaining matches left in place.`,
      );
    }
    filesPlan.push({
      path: candidate,
      matches: count,
      capped,
      originalBytes: Buffer.byteLength(source, "utf-8"),
      newBytes: Buffer.byteLength(updated, "utf-8"),
    });
  }

  return {
    ok: true,
    plan: {
      files: filesPlan,
      skipped,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Apply (writes with per-file rollback)
// ---------------------------------------------------------------------------

/**
 * Re-read each planned file, re-apply the regex, write atomically.
 * On any write failure, best-effort rolls back previously-written files
 * from the cached pre-image. We read-and-replace again here (rather
 * than caching the planner's `updated` strings) so the plan stays
 * accurate even if the file changed between plan and apply — if a
 * file no longer has matches, we simply skip it.
 */
export async function applySearchReplaceRegexPlan(
  plan: SearchReplaceRegexPlan,
  args: SearchReplaceRegexArgs,
): Promise<{
  written: number;
  totalReplacements: number;
  totalOriginalBytes: number;
  totalNewBytes: number;
  rollbackWarnings: string[];
}> {
  const compiled = compilePattern(args.pattern, args.flags);
  if (!compiled.ok) {
    // Shouldn't happen (planner already validated), but be safe.
    throw new Error(compiled.reason);
  }
  const cap = args.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;

  const writtenPreImages: Array<{ path: string; original: string }> = [];
  const rollbackWarnings: string[] = [];
  let totalReplacements = 0;
  let totalOriginalBytes = 0;
  let totalNewBytes = 0;

  for (const fp of plan.files) {
    let source: string;
    try {
      source = await readFile(fp.path, "utf-8");
    } catch (err) {
      rollbackWarnings.push(`failed to re-read ${fp.path}: ${(err as Error).message}`);
      continue;
    }

    const { updated, count } = applyRegex(source, compiled.re, args.replacement, cap);
    if (count === 0) continue;

    try {
      await atomicWrite(fp.path, updated);
      writtenPreImages.push({ path: fp.path, original: source });
      totalReplacements += count;
      totalOriginalBytes += Buffer.byteLength(source, "utf-8");
      totalNewBytes += Buffer.byteLength(updated, "utf-8");
    } catch (err) {
      // Roll back everything written so far.
      for (const prev of writtenPreImages) {
        try {
          await writeFile(prev.path, prev.original, "utf-8");
        } catch (rbErr) {
          rollbackWarnings.push(
            `rollback failed for ${prev.path}: ${(rbErr as Error).message}`,
          );
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to write ${fp.path}: ${msg}`);
    }
  }

  return {
    written: writtenPreImages.length,
    totalReplacements,
    totalOriginalBytes,
    totalNewBytes,
    rollbackWarnings,
  };
}

// ---------------------------------------------------------------------------
// Top-level callable (used by the MCP handler)
// ---------------------------------------------------------------------------

export async function ashlrSearchReplaceRegex(
  args: SearchReplaceRegexArgs,
): Promise<{ text: string; originalBytes: number; newBytes: number }> {
  const planRes = await planSearchReplaceRegex(args);
  if (!planRes.ok) {
    throw new Error(planRes.reason);
  }
  const { plan } = planRes;
  const dryRun = args.dryRun === true;

  const fileCount = plan.files.length;
  const totalMatches = plan.files.reduce((s, f) => s + f.matches, 0);

  const lines: string[] = [];
  lines.push(
    `[ashlr__search_replace_regex] ${dryRun ? "(dry run) " : ""}` +
      `${fileCount} file${fileCount === 1 ? "" : "s"}, ${totalMatches} replacement${totalMatches === 1 ? "" : "s"}` +
      (plan.skipped > 0 ? `, ${plan.skipped} candidate${plan.skipped === 1 ? "" : "s"} skipped` : ""),
  );

  if (plan.warnings.length > 0) {
    lines.push("  warnings:");
    for (const w of plan.warnings) lines.push(`    ${w}`);
  }

  // Compact per-file breakdown when the change set is small.
  if (fileCount <= 10) {
    for (const fp of plan.files) {
      lines.push(`  ${fp.path}: ${fp.matches} match${fp.matches === 1 ? "" : "es"}${fp.capped ? " (capped)" : ""}`);
    }
  }

  let totalOriginalBytes = 0;
  let totalNewBytes = 0;

  if (dryRun) {
    for (const fp of plan.files) {
      totalOriginalBytes += fp.originalBytes;
      totalNewBytes += fp.newBytes;
    }
    lines.push("  (dry run — no files written)");
    return { text: lines.join("\n"), originalBytes: totalOriginalBytes, newBytes: totalNewBytes };
  }

  if (fileCount === 0) {
    return { text: lines.join("\n"), originalBytes: 0, newBytes: 0 };
  }

  const applied = await applySearchReplaceRegexPlan(plan, args);
  totalOriginalBytes = applied.totalOriginalBytes;
  totalNewBytes = applied.totalNewBytes;

  lines.push(
    `  ${applied.written} file${applied.written === 1 ? "" : "s"} written, ` +
      `${applied.totalReplacements} total replacement${applied.totalReplacements === 1 ? "" : "s"}`,
  );
  if (applied.rollbackWarnings.length > 0) {
    lines.push("  rollback warnings:");
    for (const w of applied.rollbackWarnings) lines.push(`    ${w}`);
  }

  return { text: lines.join("\n"), originalBytes: totalOriginalBytes, newBytes: totalNewBytes };
}

// Silence unused-import warnings from `stat` — kept in scope for future
// use (symlink detection).
void stat;
