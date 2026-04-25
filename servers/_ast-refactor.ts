/**
 * _ast-refactor.ts — AST-aware refactor operations (Track C, v1.13).
 *
 * v1.13 scope: **file-local rename**, name + kind match (value vs type),
 * with a conservative shadowing guard that refuses when the target name
 * has multiple declaration sites in the file. Cross-file rename and real
 * scope-aware binding resolution (closures, nested shadowing) are v1.14.
 *
 * Invariants:
 *   - Always refuses rather than producing a subtly-wrong rename. Call
 *     sites that hit a `refused` result should surface the reason to the
 *     agent so it knows to fall back to a broader-scope tool.
 *   - Never writes the file. Returns byte-range edits; the caller (handler
 *     module or tests) applies them.
 *   - Pure AST logic — no file-system side-effects; tests pass source
 *     strings directly when useful.
 */

import { runWithTimeout } from "./_run-with-timeout";
import { writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve as pathResolve } from "path";
import type Parser from "web-tree-sitter";
import {
  extractIdentifiers,
  parseFile,
  walkNodes,
  walkSubtree,
  type ParseResult,
} from "./_ast-helpers";

/** Hard cap on the number of candidate files a cross-file rename may touch. */
const CROSS_FILE_MAX_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single byte-range edit. Replaces `[start, end)` with `replacement`.
 * Compatible with the shape needed by an in-place file write.
 */
export interface RangeEdit {
  start: number;
  end: number;
  replacement: string;
}

export type RefactorKind = "value" | "type";

export interface RenameInFileOptions {
  /**
   * If set, only rename identifiers of this kind. Defaults to "value".
   * Use `"type"` to rename a type-only symbol (interface, type alias, etc.).
   */
  kind?: RefactorKind;
  /**
   * If true, ignore the shadowing guard and rename anyway. Default false.
   * Reserved for tests and advanced callers who've already verified safety.
   */
  force?: boolean;
}

export type RenameInFileResult =
  | {
      ok: true;
      edits: RangeEdit[];
      warnings: string[];
      references: number;
      /**
       * The exact source string the tree was parsed from. Callers applying
       * the edits MUST use this string (not a fresh re-read of the file) so
       * byte offsets stay aligned — a concurrent write between the initial
       * read and the rewrite would otherwise produce silently corrupt output.
       */
      source: string;
    }
  | {
      ok: false;
      reason: string;
      warnings?: string[];
    };

// ---------------------------------------------------------------------------
// Declaration detection
// ---------------------------------------------------------------------------

/**
 * Parent-node types whose identifier child is a binding *declaration* site.
 * Used by the shadowing guard to decide whether multiple same-name
 * identifiers in the file actually introduce distinct bindings (→ refuse)
 * or are just references to a single declaration (→ safe to rename).
 */
const VALUE_DECLARATION_PARENTS = new Set([
  "variable_declarator",        // const X = …
  "function_declaration",       // function X() {}
  "function_signature",         // declare function X()
  "method_definition",          // class body: X() {}
  "class_declaration",          // class X {}
  "required_parameter",         // fn(X: T)
  "optional_parameter",         // fn(X?: T)
  "rest_parameter",             // fn(...X: T[])
  "formal_parameters",          // bare parameter id
  "import_specifier",           // import { X }
  "import_clause",              // import X from …
  "namespace_import",           // import * as X from …
  "enum_declaration",           // enum X {}
]);

const TYPE_DECLARATION_PARENTS = new Set([
  "type_alias_declaration",     // type X = …
  "interface_declaration",      // interface X {}
  "enum_declaration",           // enum X {} (also type-side)
  "type_parameter",             // generic <X>
]);

/**
 * Pattern-wrapper node types that can sit between an identifier and its
 * declaration parent (e.g., `const { a } = obj` → identifier → object_pattern
 * → variable_declarator). We walk upward THROUGH these, but refuse to skip
 * arbitrary expressions — otherwise `const x = a + b` would count `a` as a
 * declaration of itself (since its grandparent is `variable_declarator`).
 */
const PATTERN_INTERMEDIATE_TYPES = new Set([
  "array_pattern",
  "object_pattern",
  "pair_pattern",
  "rest_pattern",
  "assignment_pattern",
  "object_assignment_pattern",
]);

/**
 * Compare two SyntaxNode references by byte range. web-tree-sitter does NOT
 * guarantee reference stability — `parent.childForFieldName("name")` returns
 * a fresh JS object each call, so `===` always fails even when the underlying
 * node is the same. Comparing start/end indexes is the canonical approach.
 */
function sameNode(a: Parser.SyntaxNode | null, b: Parser.SyntaxNode | null): boolean {
  if (!a || !b) return false;
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

function isDeclarationSite(node: Parser.SyntaxNode, kind: RefactorKind): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const set = kind === "value" ? VALUE_DECLARATION_PARENTS : TYPE_DECLARATION_PARENTS;
  if (set.has(parent.type)) {
    // Field-aware check: in a variable_declarator the identifier at field
    // `name` is the binding, and the identifier at field `value` is a
    // reference to another binding. Without this check,
    //   const msg = greet;
    // counts `greet` (the initializer) as a declaration of itself.
    if (parent.type === "variable_declarator") {
      const nameField = parent.childForFieldName
        ? parent.childForFieldName("name")
        : null;
      return sameNode(nameField, node);
    }
    return true;
  }
  // Walk upward ONLY through pattern intermediate nodes (destructuring).
  // Skipping through arbitrary expressions misidentifies every identifier
  // inside an initializer as a declaration of itself.
  if (!PATTERN_INTERMEDIATE_TYPES.has(parent.type)) return false;
  let up: Parser.SyntaxNode | null = parent.parent;
  while (up && PATTERN_INTERMEDIATE_TYPES.has(up.type)) up = up.parent;
  if (up === null || !set.has(up.type)) return false;
  // If we walked through patterns to a variable_declarator, confirm we came
  // from the `name` field (left side) not `value` (right side). Compare by
  // byte-range containment since refs aren't stable.
  if (up.type === "variable_declarator") {
    const nameField = up.childForFieldName
      ? up.childForFieldName("name")
      : null;
    if (!nameField) return false;
    // node lies inside nameField iff [node.start, node.end] ⊆ [nameField.start, nameField.end].
    return (
      node.startIndex >= nameField.startIndex &&
      node.endIndex <= nameField.endIndex
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a file-local rename.
 *
 * Loads + parses the file, collects identifier references matching
 * `{name, kind}`, checks the shadowing guard, and returns a list of byte
 * ranges to replace with `newName`.
 */
export async function planRenameInFile(
  filePath: string,
  oldName: string,
  newName: string,
  options: RenameInFileOptions = {},
): Promise<RenameInFileResult> {
  const kind: RefactorKind = options.kind ?? "value";

  const nameError = validateIdentifier(newName);
  if (nameError) return { ok: false, reason: nameError };
  if (oldName === newName) {
    return { ok: false, reason: "old and new names are identical" };
  }

  const parsed = await parseFile(filePath);
  if (!parsed) {
    return {
      ok: false,
      reason: "unsupported language or grammar not wired (ashlr__edit_structural supports .ts/.tsx/.js/.jsx today)",
    };
  }

  return planRenameFromParsed(parsed, oldName, newName, kind, options.force === true);
}

/**
 * Pure variant of {@link planRenameInFile} that operates on a pre-parsed
 * tree. Convenient for tests.
 */
export function planRenameFromParsed(
  parsed: ParseResult,
  oldName: string,
  newName: string,
  kind: RefactorKind,
  force = false,
): RenameInFileResult {
  const { tree, source } = parsed;

  const allRefs = extractIdentifiers(tree, source);
  const matches = allRefs.filter((r) => r.name === oldName && r.kind === kind);

  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no ${kind}-position identifier named '${oldName}' found in file`,
    };
  }

  // Shadowing guard: count unique declaration sites. >1 means the same name
  // introduces multiple bindings (e.g., outer function + inner parameter).
  // Until we have proper scope resolution, refuse rather than silently
  // collide all of them.
  const warnings: string[] = [];
  const declarationMatches = rangesToNodes(tree, matches.map((m) => m.range)).filter(
    (n) => isDeclarationSite(n, kind),
  );
  const declarationCount = declarationMatches.length;

  if (declarationCount > 1 && !force) {
    return {
      ok: false,
      reason: `'${oldName}' has ${declarationCount} declaration sites in this file — rename refused to avoid shadowing collisions. Rename each scope individually or pass force:true after verifying safety.`,
    };
  }
  if (declarationCount === 0) {
    warnings.push(
      `no ${kind}-position declaration of '${oldName}' detected — identifier may be bound in an outer scope (imported / global). Rename applied only to the occurrences in this file.`,
    );
  }

  // Check the new name doesn't already collide with a declaration of the
  // same kind in the file.
  if (!force) {
    const collision = allRefs.some(
      (r) => r.name === newName && r.kind === kind,
    );
    if (collision) {
      return {
        ok: false,
        reason: `'${newName}' already exists as a ${kind}-position identifier in this file — would collide. Rename to a different name, or pass force:true.`,
      };
    }
  }

  const edits: RangeEdit[] = matches.map((m) => ({
    start: m.range[0],
    end: m.range[1],
    replacement: newName,
  }));

  return {
    ok: true,
    edits,
    warnings,
    references: matches.length,
    source,
  };
}

/**
 * Apply a set of byte-range edits to a source string. Edits are sorted
 * right-to-left so offsets stay valid during the rewrite. Overlapping
 * ranges (which should never come out of planRenameInFile) are detected
 * and throw.
 */
export function applyRangeEdits(source: string, edits: RangeEdit[]): string {
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * JS/TS identifier syntax check.
 *
 * Uses the ECMAScript ID_Start / ID_Continue Unicode sets (ES2018+ `/\p{}/u`
 * regex) so identifiers like `café`, `π`, `日本語` are accepted. ZWNJ (U+200C)
 * and ZWJ (U+200D) are allowed in continue position per spec.
 *
 * Tree-sitter TS/TSX/JS grammars all tokenize Unicode identifiers correctly
 * (verified — a `const café = 1` source parses as `identifier` node with
 * text "café"), so a rename plan produced here applies cleanly.
 */
function validateIdentifier(name: string): string | null {
  if (!name) return "new name is empty";
  // ES identifier: first char is ID_Start | _ | $; rest is ID_Continue | _ | $
  // | ZWNJ (U+200C) | ZWJ (U+200D).
  if (!/^[\p{ID_Start}_$][\p{ID_Continue}_$‌‍]*$/u.test(name)) {
    return `'${name}' is not a valid JS identifier (must start with a letter, '_' or '$' and contain only ID_Continue characters)`;
  }
  // Refuse reserved words proactively so the edit doesn't brick the file.
  const RESERVED = new Set([
    "break","case","catch","class","const","continue","debugger","default",
    "delete","do","else","enum","export","extends","false","finally","for",
    "function","if","import","in","instanceof","new","null","return","super",
    "switch","this","throw","true","try","typeof","var","void","while","with",
    "yield","let","static","async","await",
  ]);
  if (RESERVED.has(name)) return `'${name}' is a reserved word`;
  return null;
}

/**
 * Resolve a list of [start, end] ranges back to concrete tree nodes by
 * re-walking the tree. Inefficient (O(nodes) per plan) — deferred to v1.14
 * when `extractIdentifiers` returns SyntaxNode refs alongside the
 * {name, kind, range} tuples, making the round-trip walk unnecessary.
 */
function rangesToNodes(tree: Parser.Tree, ranges: Array<[number, number]>): Parser.SyntaxNode[] {
  const wanted = new Set(ranges.map((r) => `${r[0]}:${r[1]}`));
  const out: Parser.SyntaxNode[] = [];
  walkNodes(tree, (n) => {
    if (wanted.has(`${n.startIndex}:${n.endIndex}`)) out.push(n);
  });
  return out;
}

// ---------------------------------------------------------------------------
// resolveRg — locate ripgrep binary (mirrors efficiency-server.ts approach)
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
// Cross-file rename
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

/**
 * Plan a cross-file rename of `oldName` → `newName` across all files in
 * `rootDir` matching the include globs.
 *
 * Scope rules (v1.18.1):
 *   - If `anchorFile` is provided, importers are detected via AST of each
 *     candidate file: we look for `import_specifier`, `import_clause`
 *     (default), `namespace_import`, and CJS `require` destructuring calls
 *     whose source string resolves to `anchorFile`. Only in matching files
 *     is the rename applied. Local same-named identifiers in unrelated
 *     files are left alone.
 *   - `ns.oldName` (namespace-qualified access) is also renamed when the
 *     namespace binding points at `anchorFile`.
 *   - Module *path* strings (e.g., `"./foo"`) are NEVER rewritten — we rename
 *     the symbol, not the module URL.
 *   - Without `anchorFile`, legacy behavior: every file containing the
 *     identifier is a rename candidate (v1.13 semantics).
 *
 * Safety caps:
 *   - Hard cap of `maxFiles` (default 200) — ripgrep output is truncated with
 *     a warning rather than applied if exceeded.
 *   - Per-file shadowing guard inherited from `planRenameInFile`.
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

/**
 * Apply cross-file rename edits: reads each file's stored source, applies
 * edits, writes atomically. Returns count of files written.
 */
export async function applyCrossFileRenameEdits(
  fileEdits: Array<{ path: string; edits: RangeEdit[]; source: string }>,
): Promise<number> {
  let count = 0;
  for (const fe of fileEdits) {
    const after = applyRangeEdits(fe.source, fe.edits);
    if (after !== fe.source) {
      await writeFile(fe.path, after, "utf-8");
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Extract function
// ---------------------------------------------------------------------------

export interface ExtractFunctionOptions {
  newFunctionName: string;
  /** Byte range of the expression/statement block to extract. */
  start: number;
  end: number;
}

export interface ExtractFunctionResult {
  ok: boolean;
  edits?: RangeEdit[];
  source?: string;
  reason?: string;
  /** Soft warnings the caller should surface to the user (only set on ok:true). */
  warnings?: string[];
}

/**
 * File-local extract-function with return-value detection (v1.18.1).
 *
 * Three shapes of extract:
 *   1. Single expression → `function extracted() { return <expr>; }` +
 *      call site replaces range with `extracted(args)`.
 *   2. Statements whose internals are not read after the range → no return;
 *      call site becomes `extracted(args);` (bare expression statement).
 *   3. Statements where exactly one value declared-or-written-inside is read
 *      later in the enclosing scope → `return x;` and call site
 *      `const x = extracted(args);` (or `let` if the binding was reassigned).
 *      Multiple outputs → `return { a, b };` + `const { a, b } = extracted(args);`.
 *
 * Constraints retained from v1.14 MVP:
 *   - Refuses ranges containing `return`, `throw`, `await`, or `yield`.
 *   - Params are typed `unknown` (no type-checker).
 *   - Inserts extracted function BEFORE the enclosing top-level scope.
 *
 * Outputs are always written as `const { a, b } = …` destructuring so the
 * call-site stays readable. If the binding already existed and was only
 * reassigned (not declared) inside the range, we emit `({ a, b } = …)` form
 * instead to avoid redeclaration — flagged as a warning for now since we
 * don't yet distinguish declaration vs. re-assignment rigorously.
 */
export function planExtractFunction(
  parsed: ParseResult,
  options: ExtractFunctionOptions,
): ExtractFunctionResult {
  const { tree, source } = parsed;
  const { newFunctionName, start, end } = options;

  // Validate new function name
  const nameErr = validateIdentifier(newFunctionName);
  if (nameErr) return { ok: false, reason: nameErr };

  if (start >= end) {
    return { ok: false, reason: "extract range is empty (start >= end)" };
  }
  if (start < 0 || end > source.length) {
    return { ok: false, reason: `extract range [${start}, ${end}] is out of source bounds` };
  }

  const body = source.slice(start, end);

  if (/\breturn\b/.test(body)) {
    return { ok: false, reason: "extracted range contains 'return' — extract does not support early returns from the target block" };
  }
  if (/\bthrow\b/.test(body)) {
    return { ok: false, reason: "extracted range contains 'throw' — extract does not support throw statements" };
  }
  if (/\bawait\b/.test(body)) {
    return { ok: false, reason: "extracted range contains 'await' — extract does not support async/await (the enclosing fn would need to become async too)" };
  }
  if (/\byield\b/.test(body)) {
    return { ok: false, reason: "extracted range contains 'yield' — extract does not support generator yields" };
  }

  // Find the smallest node that fully contains the range
  let targetNode: Parser.SyntaxNode | null = null;
  walkNodes(tree, (n) => {
    if (n.startIndex <= start && n.endIndex >= end) {
      if (targetNode === null || (n.endIndex - n.startIndex) < (targetNode.endIndex - targetNode.startIndex)) {
        targetNode = n;
      }
    }
  });

  if (!targetNode) {
    return { ok: false, reason: "could not find an enclosing node for the given range" };
  }
  const tn = targetNode as Parser.SyntaxNode;

  const EXPRESSION_TYPES = new Set([
    "binary_expression", "call_expression", "member_expression",
    "ternary_expression", "unary_expression", "update_expression",
    "parenthesized_expression", "identifier", "property_identifier",
    "number", "string", "template_string", "true", "false", "null",
    "object", "array", "arrow_function", "new_expression",
    "subscript_expression", "type_assertion", "as_expression",
    "non_null_expression", "regex",
  ]);
  const STATEMENT_TYPES = new Set([
    "expression_statement", "lexical_declaration", "variable_declaration",
    "if_statement", "for_statement", "for_in_statement", "while_statement",
    "do_statement", "switch_statement", "try_statement", "block",
    "statement_block", "assignment_expression",
  ]);

  const isExpression = EXPRESSION_TYPES.has(tn.type);
  const isStatementish = STATEMENT_TYPES.has(tn.type);

  if (!isExpression && !isStatementish) {
    return {
      ok: false,
      reason: `range encloses node type '${tn.type}' which is neither an expression nor a statement — extract not supported for this shape`,
    };
  }

  // --- Identifier analysis ------------------------------------------------
  const allRefs = extractIdentifiers(tree, source);
  const refsInRange = allRefs.filter(
    (r) => r.kind === "value" && r.range[0] >= start && r.range[1] <= end,
  );

  // Names declared/written inside the range (via variable declarators, assignments,
  // destructuring patterns, parameter defaults etc.).
  const declaredInRange = new Set<string>();
  walkNodes(tree, (n) => {
    if (n.startIndex < start || n.endIndex > end) return;
    if (n.type === "identifier" && isDeclarationSite(n, "value")) {
      declaredInRange.add(n.text);
    }
  });
  // Names written (assigned / updated) inside the range — captures non-declaration
  // reassignment cases like `x = 5;` / `x += 1;`. We track both the declarations
  // and these writes to decide what could possibly be "output" of the extracted fn.
  const writtenInRange = new Set<string>(declaredInRange);
  walkNodes(tree, (n) => {
    if (n.startIndex < start || n.endIndex > end) return;
    if (n.type === "assignment_expression") {
      const lhs = n.childForFieldName ? n.childForFieldName("left") : n.namedChild(0);
      if (lhs && lhs.type === "identifier") writtenInRange.add(lhs.text);
    }
    if (n.type === "update_expression") {
      const arg = n.namedChild(0);
      if (arg && arg.type === "identifier") writtenInRange.add(arg.text);
    }
  });

  // Parameters = identifiers referenced in range but not *declared* in range
  // and not the new function name itself. (We use declaredInRange, not
  // writtenInRange — a plain `x = 5` inside the range where `x` came from
  // outside is an outer-scope reference; `x` must be a parameter AND an output.)
  const paramNames = new Set<string>();
  for (const ref of refsInRange) {
    if (!declaredInRange.has(ref.name) && ref.name !== newFunctionName) {
      paramNames.add(ref.name);
    }
  }
  const params = [...paramNames].map((p) => `${p}: unknown`);
  const paramCall = [...paramNames].join(", ");

  // --- Return-value detection (statement form only) ----------------------
  // Find the enclosing scope to check "used after range". Scope = nearest
  // function/method body or root.
  const enclosingScope = findEnclosingScope(tree, start, end);
  const readsAfterRange = new Set<string>();
  if (isStatementish && enclosingScope) {
    const scopeStart = enclosingScope.startIndex;
    const scopeEnd = enclosingScope.endIndex;
    for (const ref of allRefs) {
      if (ref.kind !== "value") continue;
      if (ref.range[0] < end) continue; // must be AFTER the range
      if (ref.range[0] >= scopeEnd) continue; // must be within enclosing scope
      if (ref.range[0] < scopeStart) continue;
      if (writtenInRange.has(ref.name)) {
        // Skip if this "read" is itself a declaration site (e.g., re-declares
        // the name in a later block) — that's not a real read.
        readsAfterRange.add(ref.name);
      }
    }
  }

  // Outputs that need to be returned from the extracted fn.
  const outputs = [...readsAfterRange].sort();
  const declaredOutputs = outputs.filter((n) => declaredInRange.has(n));
  const reassignedOutputs = outputs.filter((n) => !declaredInRange.has(n));

  // --- Build extracted function body ---------------------------------------
  let funcBody: string;
  let callSiteExpr: string;
  const warnings: string[] = [];

  if (isExpression) {
    // Single expression extract — wrap in return.
    funcBody = `  return ${body.trim()};`;
    callSiteExpr = `${newFunctionName}(${paramCall})`;
  } else if (outputs.length === 0) {
    // Statement(s) with no outputs.
    funcBody = body.replace(/^\n|\n$/g, "").split("\n").map((l) => "  " + l).join("\n");
    callSiteExpr = `${newFunctionName}(${paramCall})`;
  } else if (outputs.length === 1) {
    const name = outputs[0]!;
    const indented = body.replace(/^\n|\n$/g, "").split("\n").map((l) => "  " + l).join("\n");
    funcBody = `${indented}\n  return ${name};`;
    if (declaredInRange.has(name)) {
      callSiteExpr = `const ${name} = ${newFunctionName}(${paramCall})`;
    } else {
      // Variable is outer-scope — reassign via expression so no redeclare.
      callSiteExpr = `${name} = ${newFunctionName}(${paramCall})`;
    }
  } else {
    // Multiple outputs → object return.
    const indented = body.replace(/^\n|\n$/g, "").split("\n").map((l) => "  " + l).join("\n");
    funcBody = `${indented}\n  return { ${outputs.join(", ")} };`;
    if (reassignedOutputs.length > 0 && declaredOutputs.length === 0) {
      // All bindings pre-exist; destructure-assign.
      callSiteExpr = `({ ${outputs.join(", ")} } = ${newFunctionName}(${paramCall}))`;
    } else if (declaredOutputs.length === outputs.length) {
      // All freshly declared inside range — safe to `const`-destructure.
      callSiteExpr = `const { ${outputs.join(", ")} } = ${newFunctionName}(${paramCall})`;
    } else {
      // Mixed: some declared inside range, some outer-scope reassigned.
      // A `const { a, b } = ...` destructure would shadow the outer-scope names
      // of the reassigned bindings. Detect this and refuse rather than emit a
      // silent advisory.
      //
      // Shadowing detector: for every name in reassignedOutputs, check whether
      // it is already declared (or is a parameter) in the enclosing scope
      // *outside* the extraction range. If so, `const { name } = ...` at the
      // call site would introduce a new binding that shadows it.
      const enclosingScopeBindings = new Set<string>();
      if (enclosingScope) {
        walkNodes(tree, (n) => {
          // Only look at nodes inside the enclosing scope but outside the range
          if (n.startIndex >= start && n.startIndex < end) return;
          if (n.startIndex < enclosingScope.startIndex) return;
          if (n.startIndex >= enclosingScope.endIndex) return;
          if (n.type === "identifier" && isDeclarationSite(n, "value")) {
            enclosingScopeBindings.add(n.text);
          }
          // Enclosing function parameters
          if (
            n.type === "identifier" &&
            n.parent?.type === "formal_parameters"
          ) {
            enclosingScopeBindings.add(n.text);
          }
          // Destructuring params: { a, b } in parameter position
          if (
            n.type === "identifier" &&
            n.parent?.type === "shorthand_property_identifier_pattern"
          ) {
            enclosingScopeBindings.add(n.text);
          }
        });
      }
      const shadowedNames = reassignedOutputs.filter((n) => enclosingScopeBindings.has(n));
      if (shadowedNames.length > 0) {
        return {
          ok: false,
          reason: `extract-function: would shadow outer-scope binding${shadowedNames.length > 1 ? "s" : ""} [${shadowedNames.join(", ")}] — use destructure-assign form manually or rename the extracted outputs.`,
        };
      }
      // No detected shadowing — emit const destructure and note the mixed shape.
      callSiteExpr = `const { ${outputs.join(", ")} } = ${newFunctionName}(${paramCall})`;
    }
  }

  // Terminator: statement form needs a trailing `;`; expression-replacing
  // form that's replacing an expression inside a larger expression shouldn't
  // append one.
  const replacement = isExpression ? callSiteExpr : `${callSiteExpr};`;

  // --- Insert location ----------------------------------------------------
  const root = tree.rootNode;
  let insertBeforeNode: Parser.SyntaxNode | null = null;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.startIndex <= start && child.endIndex >= end) {
      insertBeforeNode = child;
      break;
    }
    if (child.startIndex > start) break;
  }
  const insertAt = insertBeforeNode ? insertBeforeNode.startIndex : 0;

  const funcText = `function ${newFunctionName}(${params.join(", ")}) {\n${funcBody}\n}\n\n`;

  const edits: RangeEdit[] = [
    { start: insertAt, end: insertAt, replacement: funcText },
    { start, end, replacement },
  ];

  if (insertAt > start && insertAt < end) {
    return { ok: false, reason: "internal error: insert point overlaps with extracted range" };
  }

  return { ok: true, edits, source, warnings };
}

/**
 * Find the nearest enclosing function/method body or arrow function scope
 * for a byte range. Used by extract-function to decide the "used after"
 * analysis boundary. Falls back to the root.
 */
function findEnclosingScope(
  tree: Parser.Tree,
  start: number,
  end: number,
): Parser.SyntaxNode {
  const SCOPE_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "generator_function_declaration",
    "generator_function",
  ]);
  let best: Parser.SyntaxNode = tree.rootNode;
  let bestSize = Infinity;
  walkNodes(tree, (n) => {
    if (!SCOPE_TYPES.has(n.type)) return;
    if (n.startIndex <= start && n.endIndex >= end) {
      const size = n.endIndex - n.startIndex;
      if (size < bestSize) {
        best = n;
        bestSize = size;
      }
    }
  });
  return best;
}
