/**
 * ast-read.test.ts — AST-truncated reads (ashlr__read mode:"ast" / auto).
 *
 * Tests:
 *   (a) mode:"ast" on a multi-function .ts file → signatures + imports, no bodies, smaller
 *   (b) auto mode on a large .ts file (>6144 bytes) → skeleton used
 *   (c) non-code (.txt) and unsupported ext → falls back, no throw
 *   (d) bypassSummary:true → full file even for large .ts
 *   (e) syntactically-broken .ts → falls back gracefully (null skeleton → snip path)
 *
 * Tree-sitter cold-start note: the first call may take ~200-400ms on macOS as
 * WASM is loaded and the grammar is compiled. Subsequent calls in the same
 * process reuse the cached parser. Tests are intentionally coarse-grained on
 * the skeleton content (no byte-exact assertions) to stay resilient to minor
 * tree-sitter output changes.
 *
 * Windows: no fs-mode-sensitive operations here; no platform skips needed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrRead } from "../servers/read-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-ast-read-"));
  // clampToCwd uses process.cwd() — chdir into our tmpDir so all paths are
  // within cwd and pass the clamp guard.
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Write a file and return its absolute path. */
async function write(name: string, content: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, content, "utf-8");
  return p;
}

/**
 * Build a multi-function TypeScript source of at least `minBytes` bytes.
 * Pads with extra functions if needed.
 */
function makeLargeTs(minBytes = 8000): string {
  const base = `
import { readFile } from "fs/promises";
import { join } from "path";

/**
 * Greet a user by name.
 */
export function greet(name: string): string {
  const prefix = "Hello";
  const suffix = "!";
  return prefix + ", " + name + suffix;
}

/**
 * Add two numbers together.
 * @param a first operand
 * @param b second operand
 */
export function add(a: number, b: number): number {
  const result = a + b;
  return result;
}

export class Calculator {
  private history: number[] = [];

  compute(x: number, y: number): number {
    const r = x * y + x - y;
    this.history.push(r);
    return r;
  }

  getHistory(): number[] {
    return [...this.history];
  }
}

export type UserId = string;

export interface UserRecord {
  id: UserId;
  name: string;
  email: string;
}

export const VERSION = "1.0.0";
`;
  // Pad until we exceed minBytes with comment lines (won't affect AST symbols).
  let src = base;
  let n = 0;
  while (src.length < minBytes) {
    src += `// padding line ${n++} — ${"x".repeat(80)}\n`;
  }
  return src;
}

// ---------------------------------------------------------------------------
// (a) mode:"ast" returns signatures + imports, not full bodies
// ---------------------------------------------------------------------------

describe("mode:ast on multi-function .ts file", () => {
  test("returns function signatures and imports, bodies elided, output smaller than source", async () => {
    const src = makeLargeTs(8000);
    const p = await write("multi.ts", src);

    const result = await ashlrRead({ path: p, mode: "ast" });

    // Must be smaller than the original source.
    expect(result.length).toBeLessThan(src.length);

    // Imports preserved.
    expect(result).toContain("import { readFile }");
    expect(result).toContain("import { join }");

    // Function signatures present.
    expect(result).toContain("greet");
    expect(result).toContain("add");
    expect(result).toContain("Calculator");

    // Bodies NOT present (implementation details).
    expect(result).not.toContain('prefix + ", " + name');
    expect(result).not.toContain("x * y + x - y");

    // Elision marker present.
    expect(result).toContain("body elided");

    // Skeleton note present.
    expect(result).toContain("bypassSummary:true");
  });
});

// ---------------------------------------------------------------------------
// (b) auto mode on large .ts file uses skeleton path
// ---------------------------------------------------------------------------

describe("auto mode on large .ts file", () => {
  test("uses skeleton (elision marker present) and output is smaller", async () => {
    // Must exceed AST_THRESHOLD (6144 bytes).
    const src = makeLargeTs(8000);
    const p = await write("large.ts", src);

    const result = await ashlrRead({ path: p, mode: "auto" });

    // Skeleton indicator.
    expect(result).toContain("body elided");
    // Smaller than source.
    expect(result.length).toBeLessThan(src.length);
  });
});

// ---------------------------------------------------------------------------
// (c) non-code (.txt) and unsupported extension → snip path, no throw
// ---------------------------------------------------------------------------

describe("non-code file falls back gracefully", () => {
  test(".txt file does not throw and returns content", async () => {
    const content = "hello world\n".repeat(10);
    const p = await write("notes.txt", content);

    let result: string | undefined;
    let threw = false;
    try {
      result = await ashlrRead({ path: p, mode: "auto" });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result).toContain("hello world");
  });

  test(".md file does not throw and returns content", async () => {
    const content = "# Title\nSome docs.\n".repeat(20);
    const p = await write("readme.md", content);

    let result: string | undefined;
    let threw = false;
    try {
      result = await ashlrRead({ path: p, mode: "auto" });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (d) bypassSummary:true returns full file even for large .ts
// ---------------------------------------------------------------------------

describe("bypassSummary:true returns full file", () => {
  test("full source is present (no elision markers)", async () => {
    const src = makeLargeTs(8000);
    const p = await write("bypass.ts", src);

    const result = await ashlrRead({ path: p, bypassSummary: true });

    // Body content must be present.
    expect(result).toContain('prefix + ", " + name');
    // No skeleton elision marker.
    expect(result).not.toContain("body elided");
  });
});

// ---------------------------------------------------------------------------
// (e) syntactically-broken .ts → skeleton returns null → snip path, no throw
// ---------------------------------------------------------------------------

describe("broken .ts falls back to snip path", () => {
  test("does not throw on invalid TypeScript source", async () => {
    // Deliberately malformed: unclosed braces, random tokens.
    const broken =
      "export function oops( { {{{ \n const x = ;\n\n".repeat(200) +
      "// end\n";
    const p = await write("broken.ts", broken);

    let result: string | undefined;
    let threw = false;
    try {
      result = await ashlrRead({ path: p, mode: "ast" });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    // Whether skeleton or snip, must contain some content (not empty).
    expect((result ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (f) mode:"snip" bypasses AST even for a large .ts (regression guard)
// ---------------------------------------------------------------------------

describe("mode:snip forces snipCompact path", () => {
  test("no ast-skeleton note when mode is snip", async () => {
    const src = makeLargeTs(8000);
    const p = await write("snip.ts", src);

    const result = await ashlrRead({ path: p, mode: "snip" });

    // Skeleton-specific note must NOT appear.
    expect(result).not.toContain("ast-skeleton");
  });
});
