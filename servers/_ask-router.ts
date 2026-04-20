/**
 * _ask-router — pure routing decision logic for ashlr__ask.
 *
 * Kept free of tool-server imports so ask-server can eventually be registered
 * on the shared router (see `_router.ts`) without creating a module-load
 * circular dependency. `ask-server.ts` dispatch today still calls each
 * underlying tool directly; Phase 2 of the router migration swaps that to a
 * registry lookup once efficiency + orient + tree + glob hold registered
 * handlers.
 *
 * Only dependency: `_text-helpers.ts` for `extractKeywords`.
 */

import { extractKeywords } from "./_text-helpers";

export type RoutedTool =
  | "ashlr__read"
  | "ashlr__grep"
  | "ashlr__orient"
  | "ashlr__tree"
  | "ashlr__glob";

export interface RouteDecision {
  tool: RoutedTool;
  reason: string;
  /** Extracted value used for the underlying call (path, keyword, pattern). */
  extracted?: string;
}

/** Glob-shaped token: contains * or ? and looks like a file pattern. */
const GLOB_RE = /(?:^|\s)((?:\*\*\/|[\w.\-]+\/)*[\w.*?\-]+\*[\w.*?\-/]*|[\w.*?\-/]*\*[\w.*?\-/]*\.[\w]+)(?:\s|$)/;

/** Path-like token: starts with / or ./ or contains a file extension, or is a dotfile like .env */
const PATH_RE = /(?:^|\s)((?:\/|\.\/|~\/|[\w\-]+\/)+[\w.\-]+|\.[\w]+|[\w\-]+\.(?:ts|js|tsx|jsx|py|go|rs|rb|java|md|json|yaml|yml|sh|toml|lock|txt|env|sql|graphql|proto|css|html|xml))(?:\s|$)/;

const READ_VERBS_RE = /\b(read|show\s+me|what'?s?\s+in|contents?\s+of|display|print|open)\b/i;
const GREP_VERBS_RE = /^(grep|find|search|where\s+is|where\s+are|which\s+file|look\s+for|locate)\b/i;
const STRUCTURAL_RE = /\b(how\s+does|how\s+do(?:es)?\s+we|explain|walk\s+me\s+through|why\s+does|how\s+is|what\s+is\s+the\s+(?:flow|pattern|architecture)|how\s+(?:does|do|is|are)\s+(?:the\s+)?(?:\w+\s+){0,3}work)\b/i;
const TREE_VERBS_RE = /\b(list|show|tree|structure|directory|layout|overview|scaffold|outline)\b/i;

/**
 * Decide which ashlr tool should handle a natural-language question.
 *
 * Pure function. No I/O, no env, no tool imports. First match wins; falls
 * back to `ashlr__orient` for the empty/ambiguous case since orient handles
 * multi-file synthesis best.
 */
export function routeQuestion(question: string): RouteDecision {
  const q = question.trim();

  // 1. Glob-shaped token — highest priority so "find **/*.ts" → glob, not grep.
  const globMatch = GLOB_RE.exec(q);
  if (globMatch) {
    return { tool: "ashlr__glob", reason: "glob-pattern token", extracted: globMatch[1]!.trim() };
  }

  // 2. Read verbs + path token.
  if (READ_VERBS_RE.test(q)) {
    const pathMatch = PATH_RE.exec(q);
    if (pathMatch) {
      return { tool: "ashlr__read", reason: "read verb + path token", extracted: pathMatch[1]!.trim() };
    }
  }

  // 3. Grep/search verbs (anchored at start for precision).
  if (GREP_VERBS_RE.test(q)) {
    const keywords = extractKeywords(q);
    const kw = keywords[0] ?? q.split(/\s+/).slice(1, 3).join(" ");
    return { tool: "ashlr__grep", reason: "search verb", extracted: kw };
  }

  // 4. Structural / explanatory questions.
  if (STRUCTURAL_RE.test(q)) {
    return { tool: "ashlr__orient", reason: "structural query" };
  }

  // 5. List/tree/structure with no specific pattern.
  if (TREE_VERBS_RE.test(q) && !PATH_RE.test(q)) {
    return { tool: "ashlr__tree", reason: "structural listing request" };
  }

  // Fallback: orient handles multi-file synthesis best.
  return { tool: "ashlr__orient", reason: "fallback — no rule matched" };
}
