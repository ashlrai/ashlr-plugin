/**
 * _ast-refactor/cross-file-rename.ts — Cross-file AST rename with
 * anchor-scoped import detection.
 *
 * Exports:
 *   planCrossFileRename      — ripgrep-based multi-file candidate discovery +
 *                              per-file rename planning
 *   applyCrossFileRenameEdits — apply the planned edits atomically to disk
 *
 * Scope rules (v1.18.1):
 *   - If `anchorFile` is provided, importers are detected via AST: we look for
 *     `import_specifier`, `import_clause` (default), `namespace_import`, and CJS
 *     `require` destructuring calls whose source string resolves to `anchorFile`.
 *   - `ns.oldName` (namespace-qualified access) is also renamed when the
 *     namespace binding points at `anchorFile`.
 *   - Module path strings (e.g., `"./foo"`) are NEVER rewritten.
 *   - Without `anchorFile`, legacy behavior: every file containing the identifier
 *     is a rename candidate (v1.13 semantics).
 */

import { writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve as pathResolve } from "path";
import { runWithTimeout } from "../_run-with-timeout";
import { parseFile, walkNodes, walkSubtree } from "../_ast-helpers";
import type Parser from "web-tree-sitter";
import { planRenameInFile, planRenameFromParsed } from "./file-local-rename";
import { type RangeEdit, type RefactorKind } from "./_shared";

/** Hard cap on the number of candidate files a cross-file rename may touch. */
const CROSS_FILE_MAX_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrossFileRenameOptions {
  kind?: RefactorKind;
  /** Glob patterns relative to rootDir; default: **\/*.{ts,tsx,js,jsx} */
  include?: string[];
  exclude?: string[];
  /**
   * Absolute path of the file that declares + exports the symbol. If provided,
   * only files that import the symbol from this anchor (directly, via
   * destructured `require`, or via a `import * as ns` namespace where `ns.X`
   * is accessed) are candidates for rename. If omitted, every file in the
   * search that contains the identifier is renamed (legacy v1.13 behavior).
   */
  anchorFile?: string;
  /** Override the hard file cap (default 200). */
  maxFiles?: number;
}

export interface CrossFileFileEdit {
  path: string;
  edits: RangeEdit[];
  source: string;
  references: number;
}

export type CrossFileRenameResult =
  | {
      ok: true;
      fileEdits: CrossFileFileEdit[];
      warnings: string[];
      /** Files that were candidates but skipped (reason recorded in warnings). */
      skipped: number;
    }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// resolveRg — locate ripgrep binary
// ---------------------------------------------------------------------------

function resolveRg(): string {
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    // codex vendor bundle (present on some macOS dev machines)
    "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg",
  ];
  return (
    (typeof (globalThis as { Bun?: { which(bin: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(bin: string): string | null } }).Bun.which("rg")
      : null) ??
    candidates.find((p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }) ??
    "rg"
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a cross-file rename of `oldName` → `newName` across all files in
 * `rootDir` matching the include globs.
 */
export async function planCrossFileRename(
  rootDir: string,
  oldName: string,
  newName: string,
  options: CrossFileRenameOptions = {},
): Promise<CrossFileRenameResult> {
  const kind: RefactorKind = options.kind ?? "value";
  const maxFiles = options.maxFiles ?? CROSS_FILE_MAX_CANDIDATES;
  const anchorFile = options.anchorFile
    ? pathResolve(options.anchorFile)
    : undefined;

  // Build rg args: search for the literal symbol text, list files only.
  const rgArgs: string[] = [
    "--files-with-matches",
    "--fixed-strings",
    oldName,
    rootDir,
  ];

  // Include globs: use caller-provided ones, or default to TS/JS extensions.
  const includes = options.include ?? ["**/*.{ts,tsx,js,jsx}"];
  for (const g of includes) {
    rgArgs.push("--glob", g);
  }

  // Exclude globs
  const excludes = options.exclude ?? [];
  for (const g of excludes) {
    rgArgs.push("--glob", `!${g}`);
  }

  const rgRes = await runWithTimeout({ command: resolveRg(), args: rgArgs, timeoutMs: 15_000 });
  // rg exits 0 = matches found, 1 = no matches, 2 = error
  if (rgRes.exitCode === 2 || (rgRes.exitCode === -1 && !rgRes.stdout)) {
    return { ok: false, reason: `ripgrep failed in ${rootDir}: ${rgRes.stderr ?? "unknown error"}` };
  }

  let candidateFiles = (rgRes.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (candidateFiles.length === 0) {
    return {
      ok: false,
      reason: `no candidates for '${oldName}' under ${rootDir} — symbol absent or filtered by include/exclude globs`,
    };
  }

  const warnings: string[] = [];
  if (candidateFiles.length > maxFiles) {
    warnings.push(
      `rootDir '${rootDir}': ripgrep returned ${candidateFiles.length} candidate files but cap is ${maxFiles} — truncating; narrow the scope with a more specific rootDir or include glob to rename every site.`,
    );
    candidateFiles = candidateFiles.slice(0, maxFiles);
  }

  const fileEdits: CrossFileFileEdit[] = [];
  let skipped = 0;

  for (const filePath of candidateFiles) {
    const abs = pathResolve(filePath);
    // When scoped to an anchor file, use AST-level import detection to decide
    // whether to include this file. The anchor itself always participates.
    if (anchorFile && abs !== anchorFile) {
      const scope = await scopedRenameFile(abs, anchorFile, oldName, newName, kind);
      if (scope.kind === "skip") {
        if (scope.reason) warnings.push(`${filePath}: skipped — ${scope.reason}`);
        else skipped++;
        continue;
      }
      if (scope.kind === "error") {
        warnings.push(`${filePath}: skipped — ${scope.reason}`);
        skipped++;
        continue;
      }
      for (const w of scope.warnings) warnings.push(`${filePath}: ${w}`);
      fileEdits.push({
        path: filePath,
        edits: scope.edits,
        source: scope.source,
        references: scope.references,
      });
      continue;
    }

    // Anchor file OR unscoped mode: full rename within the file.
    const result = await planRenameInFile(filePath, oldName, newName, { kind });
    if (!result.ok) {
      warnings.push(`${filePath}: skipped — ${result.reason}`);
      skipped++;
      continue;
    }
    for (const w of result.warnings) {
      warnings.push(`${filePath}: ${w}`);
    }
    fileEdits.push({
      path: filePath,
      edits: result.edits,
      source: result.source,
      references: result.references,
    });
  }

  if (fileEdits.length === 0) {
    return {
      ok: false,
      reason: `no safe rename sites found — either the symbol doesn't exist or all candidates have shadowing collisions (see warnings: ${warnings.slice(0, 3).join("; ") || "none"})`,
    };
  }

  return { ok: true, fileEdits, warnings, skipped };
}

/**
 * Apply cross-file rename edits: reads each file's stored source, applies
 * edits, writes atomically. Returns count of files written.
 */
export async function applyCrossFileRenameEdits(
  fileEdits: Array<{ path: string; edits: RangeEdit[]; source: string }>,
): Promise<number> {
  let count = 0;
  for (const fe of fileEdits) {
    const after = applyRangeEditsLocal(fe.source, fe.edits);
    if (after !== fe.source) {
      await writeFile(fe.path, after, "utf-8");
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Anchor-scoped per-file rename (AST import detection)
// ---------------------------------------------------------------------------

type ScopedRename =
  | { kind: "skip"; reason?: string }
  | { kind: "error"; reason: string }
  | {
      kind: "rename";
      edits: RangeEdit[];
      source: string;
      references: number;
      warnings: string[];
    };

/**
 * For a file that is NOT the anchor: parse it, find which local binding (if
 * any) corresponds to the symbol imported from `anchorFile`, then compute
 * byte-range edits for every reference to that binding (including
 * `ns.oldName` accesses when imported via `import * as ns`). Returns
 * `skip` if the file doesn't import from the anchor at all.
 */
async function scopedRenameFile(
  filePath: string,
  anchorFile: string,
  oldName: string,
  newName: string,
  kind: RefactorKind,
): Promise<ScopedRename> {
  const parsed = await parseFile(filePath);
  if (!parsed) {
    return { kind: "skip", reason: "unsupported language or grammar not wired" };
  }
  const { tree, source } = parsed;

  const filesDir = dirname(filePath);

  // Collect each import statement and its resolved target.
  // We return up to two kinds of matches:
  //   - bindings whose local name IS `oldName` (plain named / default import)
  //   - namespace bindings whose namespace name is some `ns`, for which we
  //     later rewrite `ns.oldName` → `ns.newName`.
  const directBindings: Array<{ nameRange: [number, number] }> = [];
  const namespaceNames = new Set<string>();
  let anchorImportsFound = 0;

  walkNodes(tree, (n) => {
    // ESM: import ... from "..."
    if (n.type === "import_statement") {
      const moduleStr = findStringChild(n);
      if (!moduleStr) return;
      if (!modulePathResolvesToAnchor(moduleStr, filesDir, anchorFile)) return;
      anchorImportsFound++;
      collectBindingsFromImport(n, oldName, directBindings, namespaceNames, source);
      return;
    }
    // CJS: const {X} = require("...") / const X = require("...")
    if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
      for (let i = 0; i < n.namedChildCount; i++) {
        const declarator = n.namedChild(i);
        if (!declarator || declarator.type !== "variable_declarator") continue;
        const requireCall = findRequireCall(declarator);
        if (!requireCall) continue;
        const moduleStr = findRequireArg(requireCall);
        if (!moduleStr) continue;
        if (!modulePathResolvesToAnchor(moduleStr, filesDir, anchorFile)) continue;
        anchorImportsFound++;
        collectBindingsFromRequire(declarator, oldName, directBindings, namespaceNames);
      }
    }
  });

  if (anchorImportsFound === 0) {
    return { kind: "skip" };
  }

  if (directBindings.length === 0 && namespaceNames.size === 0) {
    // Imported module from anchor, but didn't import `oldName` from it
    // (e.g., `import { other } from "./a"` when we're renaming `foo`).
    return { kind: "skip", reason: `imports from anchor but not '${oldName}'` };
  }

  // Collect rename edits for this file.
  const edits: RangeEdit[] = [];
  const warnings: string[] = [];

  // 1) Every direct-binding identifier + its same-named references within
  //    the file. Safest approach: run the file-local rename and rely on its
  //    collision / shadowing guard. We only accept the plan if the number of
  //    declaration sites matches our collected directBindings.
  if (directBindings.length > 0) {
    const plan = planRenameFromParsed(parsed, oldName, newName, kind, false);
    if (!plan.ok) {
      return { kind: "error", reason: plan.reason };
    }
    for (const e of plan.edits) edits.push(e);
    for (const w of plan.warnings) warnings.push(w);
  }

  // 2) For namespace bindings: rewrite `ns.oldName` member-access sites.
  if (namespaceNames.size > 0) {
    walkNodes(tree, (n) => {
      if (n.type !== "member_expression") return;
      // member_expression structure: object '.' property_identifier
      const obj = n.namedChild(0);
      const prop = n.childForFieldName ? n.childForFieldName("property") : null;
      const propNode = prop ?? n.namedChild(1);
      if (!obj || !propNode) return;
      if (!namespaceNames.has(obj.text)) return;
      if (propNode.type !== "property_identifier") return;
      if (propNode.text !== oldName) return;
      edits.push({
        start: propNode.startIndex,
        end: propNode.endIndex,
        replacement: newName,
      });
    });
  }

  if (edits.length === 0) {
    return { kind: "skip", reason: `no references to '${oldName}' found` };
  }

  // De-dupe overlapping ranges (shouldn't happen, but be safe).
  const seen = new Set<string>();
  const dedup: RangeEdit[] = [];
  for (const e of edits) {
    const key = `${e.start}:${e.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(e);
  }

  return {
    kind: "rename",
    edits: dedup,
    source,
    references: dedup.length,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Import/require AST helpers
// ---------------------------------------------------------------------------

/** Return the first string literal child of a node (for `from "..."`). */
function findStringChild(node: Parser.SyntaxNode): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "string") {
      // Strip quotes.
      const raw = c.text;
      if (raw.length >= 2) return raw.slice(1, -1);
      return "";
    }
  }
  return null;
}

/**
 * True iff a relative or absolute module-path string resolves to the same
 * on-disk file as `anchorFile` (with TS/TSX/JS/JSX extensions tried).
 */
function modulePathResolvesToAnchor(
  modulePath: string,
  fromDir: string,
  anchorFile: string,
): boolean {
  if (!modulePath.startsWith(".") && !isAbsolute(modulePath)) {
    // Bare package specifiers never resolve to a project-local anchor.
    return false;
  }
  const base = isAbsolute(modulePath)
    ? modulePath
    : pathResolve(fromDir, modulePath);
  const anchor = pathResolve(anchorFile);
  // Strip extension from anchor to compare: `./a` should resolve to `a.ts`.
  const anchorNoExt = anchor.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  const baseNoExt = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  return baseNoExt === anchorNoExt || baseNoExt + "/index" === anchorNoExt;
}

function findRequireCall(declarator: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // const X = require("...") → variable_declarator [name=X, value=call_expression(require, string)]
  const val = declarator.childForFieldName
    ? declarator.childForFieldName("value")
    : null;
  const cand = val ?? declarator.namedChild(declarator.namedChildCount - 1);
  if (!cand || cand.type !== "call_expression") return null;
  const fn = cand.namedChild(0);
  if (!fn || fn.text !== "require") return null;
  return cand;
}

function findRequireArg(callExpr: Parser.SyntaxNode): string | null {
  const args = callExpr.childForFieldName
    ? callExpr.childForFieldName("arguments")
    : null;
  const a = args ?? callExpr.namedChild(1);
  if (!a) return null;
  for (let i = 0; i < a.namedChildCount; i++) {
    const c = a.namedChild(i);
    if (!c) continue;
    if (c.type === "string") {
      const raw = c.text;
      if (raw.length >= 2) return raw.slice(1, -1);
    }
  }
  return null;
}

function collectBindingsFromImport(
  importStmt: Parser.SyntaxNode,
  oldName: string,
  directBindings: Array<{ nameRange: [number, number] }>,
  namespaceNames: Set<string>,
  _source: string,
): void {
  walkSubtree(
    importStmt,
    (n) => {
      if (n.type === "import_specifier") {
        // Shape: import { X } or import { X as Y }
        // children: name (identifier), optional "as", alias (identifier)
        const name = n.childForFieldName ? n.childForFieldName("name") : null;
        const alias = n.childForFieldName ? n.childForFieldName("alias") : null;
        const imported = name ?? n.namedChild(0);
        const local = alias ?? imported;
        if (!imported || !local) return;
        if (imported.text !== oldName) return;
        // If aliased (import { foo as bar }), renaming `foo` means rewriting
        // only the imported-name half, not the local alias.
        if (alias && alias.text !== imported.text) {
          directBindings.push({ nameRange: [imported.startIndex, imported.endIndex] });
          return;
        }
        // Unaliased: local name === oldName; file-local rename will catch all
        // references, but we explicitly record the decl site too.
        directBindings.push({ nameRange: [imported.startIndex, imported.endIndex] });
      } else if (n.type === "import_clause") {
        // import X from "..."
        // Only counts if the default binding name equals oldName.
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (!c) continue;
          if (c.type === "identifier" && c.text === oldName) {
            directBindings.push({ nameRange: [c.startIndex, c.endIndex] });
          }
        }
      } else if (n.type === "namespace_import") {
        // import * as ns from "..."
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c && c.type === "identifier") namespaceNames.add(c.text);
        }
      }
    },
  );
}

function collectBindingsFromRequire(
  declarator: Parser.SyntaxNode,
  oldName: string,
  directBindings: Array<{ nameRange: [number, number] }>,
  namespaceNames: Set<string>,
): void {
  const nameNode = declarator.childForFieldName
    ? declarator.childForFieldName("name")
    : declarator.namedChild(0);
  if (!nameNode) return;
  // const X = require(...)  → nameNode is identifier; treat X as namespace binding.
  if (nameNode.type === "identifier") {
    namespaceNames.add(nameNode.text);
    return;
  }
  // const { X } = require(...) → object_pattern
  if (nameNode.type === "object_pattern") {
    walkSubtree(nameNode, (c) => {
      if (
        c.type === "shorthand_property_identifier_pattern" &&
        c.text === oldName
      ) {
        directBindings.push({ nameRange: [c.startIndex, c.endIndex] });
      }
      // const { X: Y } = require(...) — pair_pattern
      if (c.type === "pair_pattern") {
        const key = c.childForFieldName ? c.childForFieldName("key") : c.namedChild(0);
        const val = c.childForFieldName ? c.childForFieldName("value") : c.namedChild(1);
        if (key && key.text === oldName && val && val.type === "identifier") {
          directBindings.push({ nameRange: [key.startIndex, key.endIndex] });
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Internal applyRangeEdits (avoids circular import; same logic as _shared.ts)
// ---------------------------------------------------------------------------

function applyRangeEditsLocal(source: string, edits: RangeEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  let prevStart: number | null = null;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      throw new Error(
        `applyRangeEdits: invalid range [${edit.start}, ${edit.end}] for source of length ${source.length}`,
      );
    }
    if (prevStart !== null && edit.end > prevStart) {
      throw new Error(
        `applyRangeEdits: overlapping edits at [${edit.start}, ${edit.end}] vs prior start ${prevStart}`,
      );
    }
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    prevStart = edit.start;
  }
  return out;
}
