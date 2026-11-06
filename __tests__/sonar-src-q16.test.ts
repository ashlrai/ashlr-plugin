import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { cloudSectionIdentity } from "../scripts/genome-cloud-sync";
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

describe("cloud-sync identity preserves numeric semantics and isolates unknown sources", () => {
  test.each([
    [42, "99", "42", 42], [0, "99", "0", 0],
    [undefined, "99", "99", 99], [null, "99", "99", 99], [undefined, "", "0", 0],
  ])("numeric input retains its id and GitHub number", (number, sourceSha, id, githubNumber) => {
    expect(cloudSectionIdentity(number as number | null | undefined, sourceSha as string)).toEqual({ id, githubNumber });
  });

  test("opaque identity is stable in another process and home", () => {
    const home = mkdtempSync(join(tmpdir(), "cloud-id-home-"));
    try {
      const module = new URL("../scripts/genome-cloud-sync.ts", import.meta.url).href;
      const result = spawnSync(process.execPath, ["-e", `import {cloudSectionIdentity} from ${JSON.stringify(module)}; console.log(JSON.stringify(cloudSectionIdentity(undefined, "shared-source")));`], {
        encoding: "utf8", timeout: 5000,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(cloudSectionIdentity(undefined, "shared-source"));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("unknown identifiers are deterministic, distinct, safe file keys without a GitHub number", () => {
    const sources = ["invalid", "different", "../../escape", "non-ascii-😀"];
    const keys = sources.map(source => cloudSectionIdentity(undefined, source));
    expect(new Set(keys.map(key => key.id)).size).toBe(sources.length);
    for (const [index, key] of keys.entries()) {
      expect(key.id).toMatch(/^source-[a-f0-9]{64}$/);
      expect(key.id).not.toBe("0"); expect(key.id).not.toBe("NaN");
      expect(key.githubNumber).toBeNull();
      expect(cloudSectionIdentity(undefined, sources[index]!)).toEqual(key);
    }
  });
});
