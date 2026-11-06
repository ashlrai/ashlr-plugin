/**
 * pipe-grep-arg-names.test.ts — verifies the grep example documented in
 * docs/ashlr-pipe.md and advertised in servers/pipe-server-handlers.ts calls
 * ctx.grep with the argument names ashlr__grep actually supports: the
 * required `pattern` plus `cwd` for the working directory — never
 * unsupported spellings such as query/q/path/dir/root.
 *
 * ctx.grep forwards its args object verbatim to the registered ashlr__grep
 * handler (buildCtx in servers/pipe-server.ts), so the supported names are
 * the ashlr__grep inputSchema properties. They are read here from the
 * generated servers/_tool-catalog.json — gen-tool-catalog.ts derives it from
 * the live registration in servers/grep-server-handlers.ts and CI fails on a
 * stale catalog — and cross-checked against that handler source.
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

const GUIDE = new URL("../docs/ashlr-pipe.md", import.meta.url);
const PIPE_HANDLERS = new URL("../servers/pipe-server-handlers.ts", import.meta.url);
const GREP_HANDLERS = new URL("../servers/grep-server-handlers.ts", import.meta.url);

interface GrepSchema {
  /** Property names of the ashlr__grep inputSchema — the supported args. */
  supported: Set<string>;
  /** inputSchema.required — every documented call must name these. */
  required: string[];
}

function catalogGrepSchema(): GrepSchema {
  const entries = catalog.filter((tool) => tool.name === "ashlr__grep");
  expect(entries).toHaveLength(1);
  const schema = entries[0].inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  expect(schema.properties).toBeDefined();
  return {
    supported: new Set(Object.keys(schema.properties!)),
    required: schema.required ?? [],
  };
}

interface GrepCall {
  /** Source text of the `{...}` args object. */
  args: string;
  /** Top-level keys of that object literal, in source order. */
  keys: string[];
}

/**
 * Extract the top-level keys of every `ctx.grep({...})` object literal in
 * source. Works on raw file text, so it catches calls inside JSON "expr"
 * strings, prose code spans, and the handler's advertised Example alike.
 * Calls without an object literal (e.g. `ctx.grep(args)`) are skipped —
 * there is nothing to name-check.
 */
function grepCallKeys(source: string): GrepCall[] {
  const calls: GrepCall[] = [];
  let from = 0;
  for (
    let at = source.indexOf("ctx.grep(", from);
    at !== -1;
    at = source.indexOf("ctx.grep(", (from = at + 1))
  ) {
    let i = at + "ctx.grep(".length;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== "{") continue;

    const start = i;
    let depth = 0;
    let quote: string | null = null;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}" && --depth === 0) {
        break;
      }
    }
    const args = source.slice(start, i + 1);
    calls.push({ args, keys: topLevelKeys(args) });
  }
  return calls;
}

/** Top-level `key:` identifiers of a `{...}` object literal, string-aware. */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if ("{[(".includes(ch)) {
      depth++;
    } else if ("}])".includes(ch)) {
      depth--;
    } else if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < literal.length && /[\w$]/.test(literal[end])) end++;
      let after = end;
      while (after < literal.length && /\s/.test(literal[after])) after++;
      if (literal[after] === ":") keys.push(literal.slice(i, end));
      i = end - 1;
    }
  }
  return keys;
}

/** Every JSON example in the guide whose expr calls ctx.grep. */
async function documentedGrepExprs(): Promise<string[]> {
  const guide = await readFile(GUIDE, "utf8");
  return [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((block) => (JSON.parse(block[1]) as { expr?: unknown }).expr)
    .filter((expr): expr is string => typeof expr === "string" && expr.includes("ctx.grep("));
}

/** The `Example: \`...\`` expression in the ashlr__pipe tool description. */
async function advertisedExpr(): Promise<string> {
  const source = await readFile(PIPE_HANDLERS, "utf8");
  const expr = source.match(/Example: `([^`]+)`/)?.[1];
  if (!expr) throw new Error("Missing advertised example in pipe-server-handlers.ts");
  return expr;
}

test("grep's supported argument names come from the registered tool schema", async () => {
  const { supported, required } = catalogGrepSchema();
  // The acceptance contract: `pattern` is required and `cwd` is the
  // supported working-directory argument.
  expect(required).toEqual(["pattern"]);
  expect(supported).toContain("pattern");
  expect(supported).toContain("cwd");

  // The catalog is generated from the live registration, so the handler
  // source declares the same property names.
  const handlers = await readFile(GREP_HANDLERS, "utf8");
  const propertiesBlock = handlers.match(
    /properties:\s*\{\n([\s\S]*?)\n\s{4}\},\n\s{4}required/,
  )?.[1];
  expect(propertiesBlock).toBeDefined();
  const declared = new Set(
    [...propertiesBlock!.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]),
  );
  expect(declared).toEqual(supported);
});

test("every ctx.grep call in the pipe guide uses only supported argument names", async () => {
  const [guide, { supported, required }] = await Promise.all([
    readFile(GUIDE, "utf8"),
    Promise.resolve(catalogGrepSchema()),
  ]);
  const calls = grepCallKeys(guide);
  // The guide shows nine grep calls with object literals: the ctx-methods
  // table example, the working-directory example, and the worked pipelines.
  expect(calls).toHaveLength(9);
  for (const { args, keys } of calls) {
    for (const name of required) {
      expect(keys, `missing required arg in ${args}`).toContain(name);
    }
    // Every call picks its working directory with the supported `cwd` name.
    expect(keys, args).toContain("cwd");
    for (const key of keys) {
      expect(supported, `unsupported grep argument "${key}" in ${args}`).toContain(key);
    }
  }

  // No example spells the search query or directory with names ashlr__grep
  // does not accept.
  const used = new Set(calls.flatMap((call) => call.keys));
  for (const name of ["query", "q", "regex", "path", "dir", "directory", "root", "file"]) {
    expect(used).not.toContain(name);
  }
});

test("the ctx methods table names pattern and cwd as grep's arguments", async () => {
  const [guide, { supported }] = await Promise.all([
    readFile(GUIDE, "utf8"),
    Promise.resolve(catalogGrepSchema()),
  ]);
  const row = guide.split("\n").find((line) => line.includes("`ctx.grep(args)`"));
  expect(row).toBeDefined();
  const argsCell = row!.match(/`\{([^}]*)\}`/)?.[1];
  expect(argsCell).toBeDefined();
  const names = argsCell!
    .split(",")
    .map((name) => name.trim().replace(/\?$/, ""))
    .filter((name) => name !== "...");
  expect(names).toContain("pattern");
  expect(names).toContain("cwd");
  for (const name of names) {
    expect(supported, `unsupported grep argument "${name}" in ctx methods table`).toContain(name);
  }
});

test("the handler's advertised grep example uses the supported argument names", async () => {
  const [expr, { supported, required }] = await Promise.all([
    advertisedExpr(),
    Promise.resolve(catalogGrepSchema()),
  ]);
  const calls = grepCallKeys(expr);
  expect(calls).toHaveLength(1);
  // The advertised minimal call names exactly the supported pattern + cwd.
  expect(calls[0].keys).toEqual(["pattern", "cwd"]);
  for (const name of required) {
    expect(calls[0].keys).toContain(name);
  }
  for (const key of calls[0].keys) {
    expect(supported).toContain(key);
  }
});

test("documented grep expressions reach ashlr__grep with the supported argument names", async () => {
  const [{ supported, required }, exprs, advertised] = await Promise.all([
    Promise.resolve(catalogGrepSchema()),
    documentedGrepExprs(),
    advertisedExpr(),
  ]);
  expect(exprs).toHaveLength(8);

  const snapshot = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "" }] };
      },
    });
    for (const expr of [...exprs, advertised]) {
      await ashlrPipe({ expr }, { sessionId: "pipe-grep-arg-names", env: {} });
    }
  } finally {
    __restoreRegistryForTests(snapshot);
  }

  expect(calls).toHaveLength(exprs.length + 1);
  for (const call of calls) {
    for (const name of required) {
      expect(call).toHaveProperty(name);
    }
    expect(typeof call.pattern).toBe("string");
    // The directory argument arrives under the supported `cwd` name.
    expect(typeof call.cwd).toBe("string");
    for (const key of Object.keys(call)) {
      expect(supported, `unsupported grep argument "${key}" forwarded by ctx.grep`).toContain(key);
    }
  }
});
