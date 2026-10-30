import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMapFilter } from "../scripts/fleet-ui/map-filter.js";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("S2871: map-filter signature sorts keys by code unit, not locale", () => {
  test("targeted files use explicit comparators and never localeCompare", () => {
    for (const path of ["scripts/fleet-ui/map-filter.js", "scripts/fleet-ui/node-map.js"]) {
      const source = read(path);
      expect(source).not.toMatch(/\.sort\(\s*\)/);
      expect(source).not.toMatch(/localeCompare/);
    }
  });

  test("signature orders object keys in UTF-16 code units", () => {
    // localeCompare would order 'a' before 'Z'; code units put 'Z' (0x5A) first.
    const source = read("scripts/fleet-ui/map-filter.js");
    const body = source.slice(source.indexOf("const signature ="), source.indexOf("function alpha"));
    const signature = new Function(`${body}\nreturn signature;`)() as (value: unknown) => string;
    expect(signature({ a: 1, Z: 2, ä: 3 })).toBe('{"Z":2,"a":1,"ä":3}');
    expect(signature({ b: { d: 1, c: 2 }, a: [3, { y: 1, x: 2 }] }))
      .toBe('{"a":[3,{"x":2,"y":1}],"b":{"c":2,"d":1}}');
    expect(signature("plain")).toBe('"plain"');
  });

  test("reordered detail keys do not register as a change pulse", () => {
    const filter = createMapFilter();
    const node = { id: "job:1", kind: "job", lane: "lane:a", details: { a: 1, Z: 2 } };
    filter.apply([node], 1000);
    filter.apply([{ ...node, details: { Z: 2, a: 1 } }], 1500);
    expect(filter.pulse("job:1", 1500)).toBe(0);
    filter.apply([{ ...node, details: { Z: 2, a: 2 } }], 1600);
    expect(filter.pulse("job:1", 1600)).toBe(1);
  });
});

describe("S5850: orient ranker anchors only the .log suffix", () => {
  const source = read("servers/orient-server.ts");
  const literal = source.match(/if \((\/[^/]+\/)\.test\(p\)\) score -= 10/)?.[1];
  const penalty = new Function(`return ${literal};`)() as RegExp;

  test("the exclusion pattern is grouped with a non-capturing .log branch", () => {
    expect(literal).toBe("/node_modules|dist|build|\\.lock|(?:\\.log)$/");
  });

  test.each([
    ["node_modules/auth.ts", true], ["src/auth-node_modules.ts", true],
    ["dist/auth.ts", true], ["src/auth-dist.ts", true],
    ["build/auth.ts", true], ["src/auth-build.ts", true],
    ["auth.lock.json", true], ["auth.log", true],
    ["src/auth.log.ts", false], ["src/auth.log/handler.ts", false],
    ["src/auth.ts", false], ["src/catalog.ts", false],
  ])("penalty.test(%j) === %j", (path, expected) => {
    expect(penalty.test(path)).toBe(expected);
  });
});

describe("S3923: genome shim block mapper has no identical branch", () => {
  const source = read("servers/genome-server.ts");
  const start = source.indexOf(".map((b) =>");
  const segment = source.slice(start, source.indexOf('.join("")', start));
  const block = new Function(`return (${segment.slice(".map(".length, segment.lastIndexOf(")"))});`)() as
    (b: { type: string; text?: string }) => string | undefined;

  test("non-text blocks collapse in a single fallback", () => {
    expect(segment).toContain('b.type === "text"');
    expect(segment).not.toContain('b.type === "thinking"');
    expect(segment).not.toMatch(/\?\s*""[\s\S]*:\s*""/);
  });

  test.each([
    [{ type: "text", text: "keep" }, "keep"],
    [{ type: "text" }, undefined],
    [{ type: "thinking", thinking: "private" }, ""],
    [{ type: "tool_use", id: "call" }, ""],
  ])("block %j maps to %j", (input, expected) => {
    expect(block(input as { type: string; text?: string })).toBe(expected);
  });
});

describe("S6638: cloud-sync number selection drops the dead nullish fallback", () => {
  const source = read("scripts/genome-cloud-sync.ts");
  const exprs = [...source.matchAll(/const number = (p\.number[^;]+);/g)].map((m) => m[1]);
  const pick = new Function("p", "delta", `return ${exprs[0]};`) as
    (p: { number?: number }, delta: { sourceSha: string }) => number;

  test("both section writers use the same two-operand expression", () => {
    expect(exprs).toHaveLength(2);
    for (const expr of exprs) {
      expect(expr).toBe("p.number ?? Number(delta.sourceSha)");
      expect(expr).not.toMatch(/Number\(delta\.sourceSha\)\s*\?\?/);
    }
  });

  test.each([
    [{ number: 42 }, "99", 42], [{ number: 0 }, "99", 0],
    [{}, "99", 99], [{}, "", 0],
  ])("pick(%j, %j) === %j", (p, sourceSha, expected) => {
    expect(pick(p, { sourceSha })).toBe(expected);
  });

  test("an unconvertible sourceSha stays NaN rather than collapsing to 0", () => {
    expect(pick({}, { sourceSha: "invalid" })).toBeNaN();
  });
});
