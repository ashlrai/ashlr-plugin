/**
 * _ast-languages.ts — Language registry for AST-aware editing (Track C, Sprint 1).
 *
 * Uses web-tree-sitter@0.22.6 (WASM) rather than native tree-sitter bindings.
 *
 * Why WASM over native tree-sitter:
 *   Native tree-sitter fails on macOS/Bun — node-gyp requires C++20 but the
 *   cached Node.js headers (node@25.x / node-gyp@12.x) emit flags that clang
 *   rejects. web-tree-sitter ships a self-contained WASM bundle with no native
 *   build step.
 *
 * Why web-tree-sitter@0.22.6 (not latest 0.26.x):
 *   web-tree-sitter 0.25+ requires grammar WASM files to contain a `dylink.0`
 *   custom section (Emscripten side-module format). The `tree-sitter-wasms`
 *   package (0.1.13) ships grammars built with older Emscripten that omit this
 *   section, so they fail to load under 0.26.x with "need dylink section".
 *   Version 0.22.6 uses the pre-dylink loading path and accepts these grammars.
 *   Sprint-2 can upgrade if a compatible grammar bundle ships for 0.26.x.
 *
 * Grammar WASM files: `tree-sitter-wasms` npm package (pre-built assets).
 *
 * Day-1 support: TypeScript, TSX, JavaScript.
 * Stubs only: Python, Go, Rust (sprint-2).
 */

// web-tree-sitter@0.22.x uses a default export. Sub-types (Tree, Language, etc.)
// live in the Parser namespace.
import Parser from "web-tree-sitter";
import { resolve } from "path";
import { fileURLToPath } from "url";

// Re-export the Parser class so consumers can use `import type { WTSParser }` for
// instance-type annotations without importing the whole module.
export type WTSParser = Parser;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Language = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust";

// ---------------------------------------------------------------------------
// Extension → Language map
// ---------------------------------------------------------------------------

const EXT_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  // Stubs — resolveLanguage returns them so callers can check,
  // but getParser throws for these until sprint 2.
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

/**
 * Map a filename (or bare extension) to its Language key.
 * Returns null for unrecognised extensions.
 */
export function resolveLanguage(filename: string): Language | null {
  // Accept both "foo.ts" and ".ts"
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot).toLowerCase();
  return EXT_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Lazy parser cache (one Parser instance per Language per process)
// ---------------------------------------------------------------------------

/** Set of languages with fully wired grammars in this sprint. */
const WIRED_LANGUAGES: ReadonlySet<Language> = new Set(["typescript", "tsx", "javascript"]);

let _tsInitialized = false;

/** Absolute path to the tree-sitter-wasms/out directory. */
function wasmDir(): string {
  // Resolve relative to this file so it works from any cwd.
  const here = fileURLToPath(import.meta.url);
  // servers/_ast-languages.ts → root → node_modules
  return resolve(here, "../../node_modules/tree-sitter-wasms/out");
}

/** Grammar file names for each supported language. */
const GRAMMAR_FILES: Record<Language, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  // Sprint-2 placeholders — getParser throws before reaching these.
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
};

const _parserCache = new Map<Language, Parser>();
let _initPromise: Promise<void> | null = null;

/** Ensure web-tree-sitter WASM runtime is initialized (idempotent). */
async function ensureInit(): Promise<void> {
  if (_tsInitialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const wasmPath = resolve(
      fileURLToPath(import.meta.url),
      "../../node_modules/web-tree-sitter/tree-sitter.wasm"
    );
    await Parser.init({
      locateFile: () => wasmPath,
    });
    _tsInitialized = true;
  })();
  return _initPromise;
}

/**
 * Return a cached (or freshly constructed) Parser for the given Language key.
 *
 * Throws for languages not yet wired in this sprint (Python, Go, Rust).
 */
export async function getParser(lang: Language): Promise<Parser> {
  if (!WIRED_LANGUAGES.has(lang)) {
    throw new Error(
      `[ast-languages] Grammar for '${lang}' is not wired yet (sprint-2 deliverable). ` +
      `Call resolveLanguage() and check before calling getParser().`
    );
  }

  const cached = _parserCache.get(lang);
  if (cached) return cached;

  await ensureInit();

  const grammarPath = resolve(wasmDir(), GRAMMAR_FILES[lang]);
  const language = await Parser.Language.load(grammarPath);
  const parser = new Parser();
  parser.setLanguage(language);

  _parserCache.set(lang, parser);
  return parser;
}
