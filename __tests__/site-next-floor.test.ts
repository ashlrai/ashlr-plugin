import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Dependabot security floor: the 15.x line is patched at 15.5.28.
const FLOOR = "15.5.28";
const MAJOR = 15;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

type Triple = [number, number, number];

// Lowest version a manifest spec can name: strips range syntax (^, ~, >=, v)
// and treats missing segments as zero, so "15" means 15.0.0.
function floorOf(spec: string): Triple {
  const match = spec.match(/\d+(?:\.\d+){0,2}/);
  if (!match) throw new Error(`Cannot parse next version spec: ${spec}`);
  const parts = match[0].split(".").map(Number) as number[];
  while (parts.length < 3) parts.push(0);
  return parts as Triple;
}

const atLeast = (version: Triple, floor: Triple) =>
  version[0] > floor[0] ||
  (version[0] === floor[0] && (version[1] > floor[1] ||
    (version[1] === floor[1] && version[2] >= floor[2])));

function expectAtOrAboveFloor(version: Triple, source: string): void {
  expect(version[0], `${source} must stay on next major ${MAJOR}`).toBe(MAJOR);
  expect(atLeast(version, floorOf(FLOOR)), `${source} resolves next below ${FLOOR}`).toBe(true);
}

describe("site next.js security floor", () => {
  test("site/package.json declares next at or above the patched floor", () => {
    const pkg = JSON.parse(read("../site/package.json"));
    const spec = pkg.dependencies?.next;
    expect(typeof spec).toBe("string");
    expectAtOrAboveFloor(floorOf(spec), "site/package.json");
  });

  test("site/bun.lock pins next at or above the floor", () => {
    const match = read("../site/bun.lock").match(/"next": \["next@(\d+\.\d+\.\d+)/);
    if (match === null) throw new Error("site/bun.lock does not pin a next version");
    expectAtOrAboveFloor(floorOf(match[1]), "site/bun.lock");
  });
});
