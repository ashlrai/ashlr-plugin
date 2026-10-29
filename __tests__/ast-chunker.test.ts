/**
 * ast-chunker.test.ts - Symbol-level AST chunker prototype (v1.15 prep).
 *
 * Design decisions captured here:
 *   - Only TOP-LEVEL declarations are chunked. A nested function inside a
 *     class method is not chunked separately; the class owns one chunk for
 *     its entire body.
 *   - Empty files return [] (not null). null is reserved for unsupported
 *     languages/extensions.
 *   - For export_statement wrappers, byte/line extents cover the full export
 *     node (including the `export` keyword).
 */

// All suites run: the historical macOS tree-sitter timeouts that forced
// describe.skip were resolved by the web-tree-sitter 0.22.x upgrade.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, relative } from "path";

import {
  chunkToRagString,
  splitFileIntoChunks,
  type CodeChunk,
} from "../servers/_ast-chunker";

let tmpDir: string;
const CWD = process.cwd();

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-ast-chunker-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function write(name: string, content: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// 1. Single function → 1 chunk, correct symbol / kind / lines
// ---------------------------------------------------------------------------

describe("single function declaration", () => {
  test("returns 1 chunk with correct metadata", async () => {
    const src = `function greet(name: string): string {
  return "hello " + name;
}
`;
    const path = await write("greet.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBe(1);

    const c = chunks![0]!;
    expect(c.symbol).toBe("greet");
    expect(c.kind).toBe("function");
    expect(c.startLine).toBe(1);
    expect(c.endLine).toBe(3);
    expect(c.file).toBe(relative(CWD, path));
  });
});

// ---------------------------------------------------------------------------
// 2. Mixed declarations → 5 chunks, kinds preserved
// ---------------------------------------------------------------------------

describe("mixed declarations", () => {
  test("function + class + type + interface + const → 5 chunks", async () => {
    const src = `export function doSomething(): void {}
export class MyClass {}
export type MyType = string;
export interface MyInterface {}
export const MY_CONST = 42;
`;
    const path = await write("mixed.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBe(5);

    const kinds = chunks!.map((c) => c.kind);
    expect(kinds).toContain("function");
    expect(kinds).toContain("class");
    expect(kinds).toContain("type");
    expect(kinds).toContain("interface");
    expect(kinds).toContain("const");

    const symbols = chunks!.map((c) => c.symbol);
    expect(symbols).toContain("doSomething");
    expect(symbols).toContain("MyClass");
    expect(symbols).toContain("MyType");
    expect(symbols).toContain("MyInterface");
    expect(symbols).toContain("MY_CONST");
  });
});

// ---------------------------------------------------------------------------
// 3. JSDoc docstring captured
// ---------------------------------------------------------------------------

describe("docstring extraction", () => {
  test("captures JSDoc block immediately before function", async () => {
    const src = `/**
 * Upsert an embedding row.
 * @param id - record id
 */
function upsertEmbedding(id: string): void {}
`;
    const path = await write("embed.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBe(1);
    expect(chunks![0]!.docstring).toContain("Upsert an embedding row.");
    expect(chunks![0]!.docstring).toContain("@param id");
  });

  // ---------------------------------------------------------------------------
  // 4. No docstring → null
  // ---------------------------------------------------------------------------

  test("docstring is null when no preceding comment", async () => {
    const src = `function bare(): void {}\n`;
    const path = await write("bare.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks![0]!.docstring).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-line signature with generics preserved
// ---------------------------------------------------------------------------

describe("signature extraction", () => {
  test("preserves object constraints, defaults, and return types before the body", async () => {
    const signature = `export function select<T extends { id: string }>(
  value: T = { id: "fallback" } as T,
): { item: T }`;
    const path = await write("select.ts", `${signature} {
  return { item: value };
}
`);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(1);
    expect(chunks![0]!.signature).toBe(signature);
  });

  test("preserves generic parameters", async () => {
    const src = `export function merge<T extends object, U extends object>(
  a: T,
  b: U,
): T & U {
  return { ...a, ...b };
}
`;
    const path = await write("merge.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBe(1);

    const sig = chunks![0]!.signature;
    expect(sig).toBe(src.slice(0, src.indexOf(" {\n  return")));
    // Body should NOT appear in signature
    expect(sig).not.toContain("return");
    expect(sig).not.toContain("{ ...a");
  });

  test("class signature excludes class body", async () => {
    const src = `export class EventEmitter {
  private listeners: Map<string, Function[]> = new Map();
  emit(event: string): void {}
}
`;
    const path = await write("emitter.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks!.length).toBe(1);
    const sig = chunks![0]!.signature;
    expect(sig).toBe("export class EventEmitter");
    expect(sig).not.toContain("listeners");
    expect(sig).not.toContain("emit");
  });
});

// ---------------------------------------------------------------------------
// 6. Unsupported extension → null
// ---------------------------------------------------------------------------

describe("unsupported language", () => {
  test.each(["script.py", "script.go", "script.rs", "script.txt", "script"])(
    "returns null for unsupported file %s", async (name) => {
      const path = await write(name, "unsupported source\n");
      const result = await splitFileIntoChunks(path);
      expect(result).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// 7. Empty file → empty array (not null)
// ---------------------------------------------------------------------------

describe("empty file", () => {
  test.each(["ts", "tsx", "js", "mjs", "cjs", "jsx"])(
    "returns [] for empty .%s file", async (extension) => {
      const path = await write(`empty.${extension}`, "");
      const chunks = await splitFileIntoChunks(path);
      expect(chunks).not.toBeNull();
      expect(chunks).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 8. Nested function inside class method → NOT chunked separately
//    Decision: MVP chunks at top-level only. A nested function inside a class
//    method body is part of the class chunk, not its own chunk.
// ---------------------------------------------------------------------------

describe("nested function inside class (not chunked separately)", () => {
  test("class with nested method helper → 1 chunk total", async () => {
    const src = `export class Parser {
  parse(input: string): string[] {
    function tokenize(s: string): string[] {
      return s.split(" ");
    }
    return tokenize(input);
  }
}
`;
    const path = await write("parser.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks!.length).toBe(1);
    expect(chunks![0]!.kind).toBe("class");
    expect(chunks![0]!.symbol).toBe("Parser");
  });
});

// ---------------------------------------------------------------------------
// 9. chunkToRagString renders signature + docstring, no body
// ---------------------------------------------------------------------------

describe("chunkToRagString", () => {
  test("renders header + docstring + signature", () => {
    const chunk: CodeChunk = {
      symbol: "upsertEmbedding",
      kind: "function",
      signature: "function upsertEmbedding(params: UpsertParams): void",
      docstring: "/**\n * Upsert an embedding row for a given project.\n */",
      file: "src/embeddings.ts",
      startLine: 42,
      endLine: 87,
      startByte: 1000,
      endByte: 2000,
    };

    const out = chunkToRagString(chunk);
    expect(out).toContain("# src/embeddings.ts:42-87 · function · upsertEmbedding");
    expect(out).toContain("Upsert an embedding row");
    expect(out).toContain("function upsertEmbedding(params: UpsertParams): void");
    // Body is NOT in the output - chunk only has signature
    expect(out).not.toContain("return");
  });

  // ---------------------------------------------------------------------------
  // 10. chunkToRagString handles missing docstring gracefully
  // ---------------------------------------------------------------------------

  test("omits docstring section when null", () => {
    const chunk: CodeChunk = {
      symbol: "noop",
      kind: "function",
      signature: "function noop(): void",
      docstring: null,
      file: "src/util.ts",
      startLine: 1,
      endLine: 1,
      startByte: 0,
      endByte: 22,
    };

    const out = chunkToRagString(chunk);
    expect(out).toContain("# src/util.ts:1-1 · function · noop");
    expect(out).toContain("function noop(): void");
    // Should not have consecutive newlines from a missing docstring
    expect(out).not.toContain("\n\n");
  });
});

// ---------------------------------------------------------------------------
// 11. Interface declaration chunked
// ---------------------------------------------------------------------------

describe("interface declaration", () => {
  test("export interface → 1 chunk kind=interface", async () => {
    const src = `export interface Repo {
  id: string;
  name: string;
}
`;
    const path = await write("repo.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks!.length).toBe(1);
    expect(chunks![0]!.kind).toBe("interface");
    expect(chunks![0]!.symbol).toBe("Repo");
  });
});

// ---------------------------------------------------------------------------
// 12. Type alias chunked
// ---------------------------------------------------------------------------

describe("type alias declaration", () => {
  test("captures a non-exported multiline generic alias", async () => {
    const src = `type Result<T> = {
  value: T;
};
`;
    const path = await write("result.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(1);
    expect(chunks![0]!).toMatchObject({
      symbol: "Result",
      kind: "type",
      signature: "type Result<T> = { …",
      startLine: 1,
      endLine: 3,
    });
  });

  test("export type → 1 chunk kind=type", async () => {
    const src = `export type UserId = string;\n`;
    const path = await write("userid.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks!.length).toBe(1);
    expect(chunks![0]!.kind).toBe("type");
    expect(chunks![0]!.symbol).toBe("UserId");
  });
});

// ---------------------------------------------------------------------------
// 13. Line-comment block (non-JSDoc) captured as docstring
// ---------------------------------------------------------------------------

describe("line comment block docstring", () => {
  test("does not collect comments across blank lines or declarations", async () => {
    const src = `// Detached documentation.

export function bare(): void {}
// Documentation for the first function.
function first(): void {}
function second(): void {}
`;
    const path = await write("boundaries.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(3);
    expect(chunks!.map((chunk) => chunk.docstring)).toEqual([
      null,
      "// Documentation for the first function.",
      null,
    ]);
  });

  test("captures comments on an exported declaration with CRLF lines", async () => {
    const src = "// First line.\r\n// Second line.\r\nexport function documented(): void {}\r\n";
    const path = await write("documented.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(1);
    expect(chunks![0]!.docstring).toBe("// First line.\n// Second line.");
  });

  test("captures a JSDoc block in a CRLF file without stray carriage returns", async () => {
    const src = "/**\r\n * Adds two numbers.\r\n */\r\nfunction add(a: number, b: number): number {\r\n  return a + b;\r\n}\r\n";
    const path = await write("add-crlf.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(1);
    expect(chunks![0]!.docstring).toBe("/**\n * Adds two numbers.\n */");
  });

  test("captures contiguous // comments above declaration", async () => {
    const src = `// Returns the sum of two numbers.
// @param a first operand
function add(a: number, b: number): number {
  return a + b;
}
`;
    const path = await write("add.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks![0]!.docstring).toContain("Returns the sum");
    expect(chunks![0]!.docstring).toContain("@param a");
  });
});

// ---------------------------------------------------------------------------
// 14. Byte offsets are consistent with source slice
// ---------------------------------------------------------------------------

describe("byte offsets", () => {
  test("preserves source slice offsets with Unicode before and inside declarations", async () => {
    const declarations = [
      'export type Label = "café 🌍";',
      'function internal(): string { return "你好 🌍"; }',
    ];
    const prefix = "// Unicode prefix: café 🌍\r\n";
    const src = prefix + declarations.join("\r\n") + "\r\n";
    const path = await write("unicode.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(2);
    for (const [index, chunk] of chunks!.entries()) {
      expect(src.slice(chunk.startByte, chunk.endByte)).toBe(declarations[index]!);
      expect(chunk.startLine).toBe(index + 2);
      expect(chunk.endLine).toBe(index + 2);
    }
    expect(chunks![0]!.startByte).toBe(prefix.length);
  });

  test("startByte/endByte slice back to the declaration text", async () => {
    const src = `export function hello(): string {
  return "hello";
}
`;
    const path = await write("hello.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks!.length).toBe(1);
    const c = chunks![0]!;
    expect(src.slice(c.startByte, c.endByte)).toBe(src.trimEnd());
  });
});

// ---------------------------------------------------------------------------
// 15. Non-export function still chunked
// ---------------------------------------------------------------------------

describe("non-exported function", () => {
  test("keeps nested helpers inside their top-level function chunk", async () => {
    const src = `async function outer(): Promise<string> {
  function inner(): string { return "value"; }
  return inner();
}
`;
    const path = await write("nested.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks).toHaveLength(1);
    expect(chunks![0]!).toMatchObject({
      symbol: "outer",
      kind: "function",
      signature: "async function outer(): Promise<string>",
      startLine: 1,
      endLine: 4,
    });
  });

  test("function without export keyword → still chunked", async () => {
    const src = `function internal(): void {}\n`;
    const path = await write("internal.ts", src);
    const chunks = await splitFileIntoChunks(path);
    expect(chunks!.length).toBe(1);
    expect(chunks![0]!.symbol).toBe("internal");
    expect(chunks![0]!.kind).toBe("function");
  });
});
