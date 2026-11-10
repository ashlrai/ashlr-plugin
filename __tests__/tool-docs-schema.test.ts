/**
 * The hand-written tool pages under site/content/docs/tools/ each carry an
 * input-schema table. Those tables drifted from the real schemas (renamed
 * params such as `question` -> `query`, `id` -> `taskId`, invented params such
 * as `milestone`, wrong required flags). This test pins every table and every
 * JSON `arguments` example to servers/_tool-catalog.json, the generated
 * catalog of what each MCP tool actually accepts.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const toolsDir = join(root, "site/content/docs/tools");

interface Schema {
  properties?: Record<string, unknown>;
  required?: string[];
}
const catalog = new Map<string, Schema>(
  (JSON.parse(readFileSync(join(root, "servers/_tool-catalog.json"), "utf8")) as Array<{
    name: string;
    inputSchema: Schema;
  }>).map((t) => [t.name, t.inputSchema]),
);

interface Table {
  page: string;
  tool: string;
  fields: string[];
  required: string[];
}

const HEADER = /^\| (Field|Parameter) \| Type \| Required \| Description \|$/;

/** Split a markdown table row on unescaped pipes. */
function cells(row: string): string[] {
  return row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
}

function schemaTables(page: string, text: string): Table[] {
  const title = /^title: (ashlr__\w+)/m.exec(text)?.[1];
  const lines = text.split("\n");
  const tables: Table[] = [];
  let tool = title;
  let nested = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^#{2,3} .*?(ashlr__\w+)/.exec(line);
    if (heading) {
      tool = heading[1];
      nested = false;
    } else if (/^#{2,3} .*object/i.test(line)) {
      // e.g. multi-edit's "Edit object": describes array items, not top-level params.
      nested = true;
    } else if (/^#{2,3} /.test(line)) {
      nested = false;
    }
    if (!HEADER.test(line) || nested || !tool) continue;
    const fields: string[] = [];
    const required: string[] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith("|"); j++) {
      const [field, , req] = cells(lines[j]!);
      const name = field!.replace(/`/g, "");
      fields.push(name);
      if (req!.startsWith("yes")) required.push(name);
    }
    tables.push({ page, tool, fields, required });
  }
  return tables;
}

const pages = readdirSync(toolsDir).filter((f) => f.endsWith(".mdx"));
const tables = pages.flatMap((page) => schemaTables(page, readFileSync(join(toolsDir, page), "utf8")));

describe("tool doc pages match the tool catalog", () => {
  test("finds the hand-written schema tables", () => {
    expect(tables.length).toBeGreaterThan(30);
  });

  for (const t of tables) {
    test(`${t.page}: ${t.tool} lists exactly the schema's params`, () => {
      const schema = catalog.get(t.tool);
      expect(schema).toBeDefined();
      expect([...t.fields].sort()).toEqual(Object.keys(schema!.properties ?? {}).sort());
      expect([...t.required].sort()).toEqual([...(schema!.required ?? [])].sort());
    });
  }

  test("JSON examples only pass params the tool accepts", () => {
    const bad: string[] = [];
    for (const page of pages) {
      const text = readFileSync(join(toolsDir, page), "utf8");
      for (const block of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        let parsed: { tool?: string; arguments?: Record<string, unknown> };
        try {
          parsed = JSON.parse(block[1]!);
        } catch {
          continue;
        }
        if (!parsed.tool || !parsed.arguments) continue;
        const props = Object.keys(catalog.get(parsed.tool)?.properties ?? {});
        for (const key of Object.keys(parsed.arguments)) {
          if (!props.includes(key)) bad.push(`${page}: ${parsed.tool}.${key}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
