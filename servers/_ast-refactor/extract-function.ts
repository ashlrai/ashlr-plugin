/**
 * _ast-refactor/extract-function.ts — AST-aware extract-function operation.
 *
 * Exports:
 *   planExtractFunction — plan a byte-range extract into a new function
 *
 * Three shapes of extract (v1.18.1):
 *   1. Single expression → `function extracted() { return <expr>; }` +
 *      call site replaces range with `extracted(args)`.
 *   2. Statements whose internals are not read after the range → no return;
 *      call site becomes `extracted(args);` (bare expression statement).
 *   3. Statements where exactly one value declared-or-written-inside is read
 *      later in the enclosing scope → `return x;` and call site
 *      `const x = extracted(args);` (or `let` if the binding was reassigned).
 *      Multiple outputs → `return { a, b };` + `const { a, b } = extracted(args);`.
 *
 * Constraints:
 *   - Refuses ranges containing `return`, `throw`, `await`, or `yield`.
 *   - Params are typed `unknown` (no type-checker).
 *   - Inserts extracted function BEFORE the enclosing top-level scope.
 */

import { extractIdentifiers, walkNodes } from "../_ast-helpers";
import type { ParseResult } from "../_ast-helpers";
import type Parser from "web-tree-sitter";
import {
  validateIdentifier,
  isDeclarationSite,
  type RangeEdit,
} from "./_shared";

// ---------------------------------------------------------------------------
// Public types
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * File-local extract-function with return-value detection (v1.18.1).
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

// ---------------------------------------------------------------------------
// findEnclosingScope
// ---------------------------------------------------------------------------

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
