/**
 * _edit-validate.ts — Post-edit syntax validation.
 *
 * Wired languages: TypeScript (.ts/.tsx), JavaScript (.js/.mjs/.cjs/.jsx), JSON.
 * YAML: no parser in deps → skipped.
 * Everything else: skipped (returns {introducedError:false}).
 *
 * Design contract:
 *   - NEVER throws or rejects — all errors are caught and return safe defaults.
 *   - Only reports introducedError=true when the edit INTRODUCED the error
 *     (original was clean, updated is broken).
 *   - If the original already had parse errors → introducedError=false (don't blame the edit).
 *   - _ast-languages is dynamically imported so the WASM binary is NOT parsed at
 *     module load time. This keeps subprocess startup fast (~50ms vs ~1.5s with
 *     static import), ensuring spawned MCP servers stay within test timeouts.
 *   - The entire call is guarded by a 2s timeout. The timer is .unref()'d so it
 *     never prevents subprocess exit.
 */

import { extname, basename } from "path";

export interface ValidationResult {
  introducedError: boolean;
  detail: string;
}

const SAFE: ValidationResult = { introducedError: false, detail: "" };

/**
 * Timeout (ms) for the entire validation call.
 * 2s: generous for a warm parser (~microseconds), safely under typical 5s test
 * timeouts even when the subprocess has other startup overhead.
 */
const VALIDATE_TIMEOUT_MS = 2000;

/**
 * Validate that `updated` does not introduce a syntax error that was not
 * already present in `original`.
 *
 * @param absPath  Absolute path of the file (used only for extension detection).
 * @param original Content before the edit.
 * @param updated  Content after the edit.
 */
export async function validateEdit(
  absPath: string,
  original: string,
  updated: string,
): Promise<ValidationResult> {
  // Wrap everything in a timeout + catch so a hung parser never blocks a write.
  try {
    return await Promise.race([
      _validateInner(absPath, original, updated),
      new Promise<ValidationResult>((resolve) => {
        const t = setTimeout(() => resolve(SAFE), VALIDATE_TIMEOUT_MS);
        // unref so this timer never prevents subprocess exit
        if (t && typeof t === "object" && "unref" in t) (t as NodeJS.Timeout).unref();
      }),
    ]);
  } catch {
    return SAFE;
  }
}

async function _validateInner(
  absPath: string,
  original: string,
  updated: string,
): Promise<ValidationResult> {
  const ext = extname(basename(absPath)).toLowerCase();

  // -------------------------------------------------------------------------
  // JSON
  // -------------------------------------------------------------------------
  if (ext === ".json") {
    return validateJson(original, updated);
  }

  // -------------------------------------------------------------------------
  // JS / TS via tree-sitter — dynamic import keeps WASM out of module load
  // -------------------------------------------------------------------------
  const isWiredTS =
    ext === ".ts" || ext === ".tsx" || ext === ".js" ||
    ext === ".mjs" || ext === ".cjs" || ext === ".jsx";

  if (isWiredTS) {
    return await validateAst(absPath, original, updated);
  }

  // All other extensions: skip.
  return SAFE;
}

// ---------------------------------------------------------------------------
// JSON validation
// ---------------------------------------------------------------------------

function validateJson(original: string, updated: string): ValidationResult {
  let originalOk = true;
  try {
    JSON.parse(original);
  } catch {
    originalOk = false;
  }

  if (!originalOk) {
    // Original was already broken — don't blame the edit.
    return SAFE;
  }

  try {
    JSON.parse(updated);
    return SAFE;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      introducedError: true,
      detail: `JSON parse error: ${msg.slice(0, 120)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// AST (tree-sitter) validation — dynamic import so WASM isn't loaded at startup
// ---------------------------------------------------------------------------

async function validateAst(
  absPath: string,
  original: string,
  updated: string,
): Promise<ValidationResult> {
  // Dynamic import: WASM binary is parsed only on first call, not at module load.
  let resolveLanguage: (f: string) => import("./_ast-languages").Language | null;
  let getParser: (lang: import("./_ast-languages").Language) => Promise<import("./_ast-languages").WTSParser>;
  try {
    const mod = await import("./_ast-languages");
    resolveLanguage = mod.resolveLanguage;
    getParser = mod.getParser;
  } catch {
    return SAFE;
  }

  const lang = resolveLanguage(absPath);
  if (!lang || (lang !== "typescript" && lang !== "tsx" && lang !== "javascript")) {
    return SAFE;
  }

  let parser: import("./_ast-languages").WTSParser;
  try {
    parser = await getParser(lang);
  } catch {
    // Language not wired yet (Python/Go/Rust stub) — skip gracefully.
    return SAFE;
  }

  // Parse both versions. tree-sitter is synchronous despite the async wrapper.
  let origTree: ReturnType<typeof parser.parse>;
  let updTree: ReturnType<typeof parser.parse>;
  try {
    origTree = parser.parse(original);
    updTree = parser.parse(updated);
  } catch {
    return SAFE;
  }

  // If the original already had errors, don't blame the edit.
  if (origTree.rootNode.hasError) {
    return SAFE;
  }

  if (!updTree.rootNode.hasError) {
    return SAFE;
  }

  // Find the first error node and report its start line.
  const errLine = findFirstErrorLine(updTree.rootNode);
  const lineRef = errLine >= 0 ? ` at line ${errLine + 1}` : "";
  return {
    introducedError: true,
    detail: `${lang} parse error${lineRef}`,
  };
}

/**
 * Walk the tree to find the first ERROR or MISSING node.
 * Returns 0-based line number, or -1 if not found.
 */
function findFirstErrorLine(node: { type: string; startPosition: { row: number }; children: unknown[] }): number {
  if (node.type === "ERROR" || node.type === "MISSING") {
    return node.startPosition.row;
  }
  for (const child of node.children) {
    const result = findFirstErrorLine(child as { type: string; startPosition: { row: number }; children: unknown[] });
    if (result >= 0) return result;
  }
  return -1;
}
